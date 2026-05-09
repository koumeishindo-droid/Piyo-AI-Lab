// ============================================
// ビルド時に Google Sheets + Docs から全記事を取得し、
// public/ 配下に静的JSON＋静的HTML（SEO/AEO最適化済）を書き出すスクリプト。
//
// 出力:
//   public/articles.json              ← 全記事の一覧（軽量）
//   public/articles/row-N.json        ← 個別記事JSON
//   public/article/row-N.html         ← 個別記事の静的HTML（SEO/AEO最適化）
//   public/sitemap.xml                ← サイトマップ
//   public/robots.txt                 ← クローラー設定
// ============================================

const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

// ===== サイト基本設定 =====
const SITE = {
  name: 'Piyo AI Lab',
  description: 'AI初心者が安心してAI活用方法を学べるメディア',
  url: 'https://piyoai.b-steep.com',
  defaultOgImage: 'https://piyoai.b-steep.com/images/ogp-default.png',
  locale: 'ja_JP',
  twitter: '', // ある場合は @アカウント名
};

// ===== 認証 =====
function parseCredentials() {
  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      const c = JSON.parse(process.env.GOOGLE_CREDENTIALS);
      return { client_email: c.client_email, private_key: (c.private_key || '').replace(/\\n/g, '\n') };
    } catch (e) {
      console.error('❌ GOOGLE_CREDENTIALS のJSON解析に失敗:', e.message);
      return null;
    }
  }
  if (process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_PRIVATE_KEY) {
    return {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    };
  }
  return null;
}

const creds = parseCredentials();
const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

function getAuth(scopes) {
  return new google.auth.GoogleAuth({ credentials: creds, scopes });
}
const sheets = creds ? google.sheets({ version: 'v4', auth: getAuth(['https://www.googleapis.com/auth/spreadsheets.readonly']) }) : null;
const drive  = creds ? google.drive({ version: 'v3', auth: getAuth(['https://www.googleapis.com/auth/drive.readonly']) }) : null;

// ===== Google Docs HTML クリーンアップ =====
function cleanGoogleDocsHtml(html) {
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // 1) スタイル属性を消す前に、意味のある装飾を semantic タグへ変換
  // 太字: <span style="...font-weight:700|bold...">X</span> → <strong>X</strong>
  html = html.replace(
    /<span[^>]*style="[^"]*font-weight:\s*(?:bold|[6-9]\d{2})[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    '<strong>$1</strong>'
  );
  // イタリック
  html = html.replace(
    /<span[^>]*style="[^"]*font-style:\s*italic[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    '<em>$1</em>'
  );
  // 下線
  html = html.replace(
    /<span[^>]*style="[^"]*text-decoration:[^"]*underline[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    '<u>$1</u>'
  );
  // 取り消し線
  html = html.replace(
    /<span[^>]*style="[^"]*text-decoration:[^"]*line-through[^"]*"[^>]*>([\s\S]*?)<\/span>/gi,
    '<s>$1</s>'
  );

  // 2) p / h / div の text-align をクラスに変換
  html = html.replace(
    /<(p|h[1-6]|div)([^>]*)\sstyle="([^"]*)"([^>]*)>/gi,
    (match, tag, before, style, after) => {
      const align = (style.match(/text-align:\s*(center|right|justify|left)/i) || [])[1];
      const cls = align ? ` class="ta-${align.toLowerCase()}"` : '';
      // styleは消す
      return `<${tag}${before}${cls}${after}>`;
    }
  );

  // 3) クラス・ID削除（ただし上で付けた ta-* は守る）
  html = html.replace(/\sclass="(?!ta-)([^"]*)"/gi, '');
  html = html.replace(/\sid="[^"]*"/gi, '');

  html = html.replace(/href="https:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi,
    (m, url) => 'href="' + decodeURIComponent(url) + '"');
  html = html.replace(/(https:\/\/lh[0-9]*\.googleusercontent\.com\/[^"'\s>]+?)(?:=[^"'\s>]*)?(?=["'\s>])/gi, '$1=w800');
  html = html.replace(/<img([^>]*?)\/?>/gi, (m, attrs) => {
    const src = (attrs.match(/src="([^"]*)"/i) || [])[1] || '';
    const alt = (attrs.match(/alt="([^"]*)"/i) || [])[1] || '';
    return '<img src="' + src + '" alt="' + alt + '" loading="lazy" style="max-width:100%;height:auto;">';
  });

  // 4) 残りの style 属性を消す（imgは上で再構築済みなので除外）
  html = html.replace(/<(?!img)([a-z][a-z0-9]*)([^>]*?)\sstyle="[^"]*"([^>]*)>/gi, '<$1$2$3>');
  // 5) 装飾意味のない<span>を解体
  for (let i = 0; i < 5; i++) html = html.replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1');
  html = html.replace(/<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');
  html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');
  html = html.replace(/\n{3,}/g, '\n\n');
  return html;
}

async function getDocContent(docId) {
  if (!docId || !drive) return '';
  try {
    const res = await drive.files.export({ fileId: docId, mimeType: 'text/html' });
    const bodyMatch = res.data.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    return cleanGoogleDocsHtml(bodyMatch ? bodyMatch[1] : res.data);
  } catch (e) {
    console.error(`[WARN] doc取得失敗 (${docId}): ${e.message}`);
    return '';
  }
}

function getLevelLabel(level) {
  return ({ beginner: 'ひよこ', intermediate: '育ちざかり', advanced: 'にわとり' })[level] || level;
}

// Google Drive のサムネイルURLを高解像度版に変換
// 例: https://drive.google.com/thumbnail?id=XXX → ...?id=XXX&sz=w1200
function upgradeDriveThumbUrl(url) {
  if (!url) return '';
  if (!/drive\.google\.com\/thumbnail/i.test(url)) return url;
  // 既に sz パラメータがあれば w1200 に置き換え
  if (/[?&]sz=/i.test(url)) {
    return url.replace(/([?&]sz=)[^&]*/i, '$1w1200');
  }
  // sz パラメータが無ければ追加
  return url + (url.includes('?') ? '&' : '?') + 'sz=w1200';
}

// HTMLエスケープ（メタタグ用）
function escapeAttr(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// 本文からプレーンテキスト抽出（AI/検索エンジン用、最初の160字）
function extractPlainText(html, maxLen = 160) {
  const text = String(html || '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? text.slice(0, maxLen).trim() + '…' : text;
}

// ===== 静的ファイルを public/ にコピー =====
function copyStaticFiles() {
  const itemsToCopy = ['index.html', 'article.html', 'admin.html', 'images', 'api'];
  fs.mkdirSync('public', { recursive: true });
  for (const item of itemsToCopy) {
    if (!fs.existsSync(item)) continue;
    const dest = path.join('public', item);
    const stat = fs.statSync(item);
    if (stat.isDirectory()) {
      fs.cpSync(item, dest, { recursive: true });
    } else {
      fs.copyFileSync(item, dest);
    }
    console.log(`📄 copy: ${item} → ${dest}`);
  }
}

// ===== 個別記事の静的HTMLを生成（SEO/AEO最適化版） =====
function generateArticleHtml(article) {
  const url = `${SITE.url}/article/${article.id}.html`;
  const title = `${article.title} | ${SITE.name}`;
  const description = article.excerpt
    ? article.excerpt.slice(0, 160)
    : extractPlainText(article.content);
  const ogImage = article.thumbImage || SITE.defaultOgImage;
  const datePublished = article.date || new Date().toISOString().slice(0, 10);
  const ratings = Array.isArray(article.ratings) ? article.ratings : [];
  const avgRating = ratings.length ? (ratings.reduce((a, b) => a + b, 0) / ratings.length) : 0;

  // 構造化データ（Article + BreadcrumbList）
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description: description,
    image: ogImage ? [ogImage] : undefined,
    datePublished: datePublished,
    dateModified: datePublished,
    author: { '@type': 'Person', name: article.author || SITE.name },
    publisher: {
      '@type': 'Organization',
      name: SITE.name,
      logo: { '@type': 'ImageObject', url: SITE.defaultOgImage },
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': url },
    articleSection: article.category,
    inLanguage: 'ja',
  };
  // 注意: Article 型は Google のレビュースニペット対象外のため
  // aggregateRating を含めると Search Console で
  // 「<parent_node> のオブジェクトタイプが無効」エラーになる。
  // 星評価は内部表示のみで使用し、構造化データには含めない。

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ホーム', item: SITE.url },
      { '@type': 'ListItem', position: 2, name: article.category || '記事', item: SITE.url + '/?category=' + encodeURIComponent(article.category || '') },
      { '@type': 'ListItem', position: 3, name: article.title, item: url },
    ],
  };

  // 表示用 数値
  const viewsDisplay = (article.views || 0).toLocaleString();
  const ratingDisplay = (Array.isArray(article.ratings) && article.ratings.length)
    ? avgRating.toFixed(1) : '-';

  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeAttr(title)}</title>
<meta name="description" content="${escapeAttr(description)}">
<meta name="author" content="${escapeAttr(article.author || SITE.name)}">
<meta name="keywords" content="${escapeAttr([article.category, article.levelLabel, 'AI', 'AI活用', 'AI初心者'].filter(Boolean).join(','))}">
<link rel="canonical" href="${url}">

<!-- Open Graph -->
<meta property="og:type" content="article">
<meta property="og:title" content="${escapeAttr(article.title)}">
<meta property="og:description" content="${escapeAttr(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${escapeAttr(ogImage)}">
<meta property="og:site_name" content="${escapeAttr(SITE.name)}">
<meta property="og:locale" content="${SITE.locale}">
<meta property="article:published_time" content="${datePublished}">
<meta property="article:author" content="${escapeAttr(article.author || SITE.name)}">
<meta property="article:section" content="${escapeAttr(article.category || '')}">

<!-- Twitter Card -->
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(article.title)}">
<meta name="twitter:description" content="${escapeAttr(description)}">
<meta name="twitter:image" content="${escapeAttr(ogImage)}">

<!-- 構造化データ（Article） -->
<script type="application/ld+json">
${JSON.stringify(articleSchema, null, 2)}
</script>
<!-- 構造化データ（BreadcrumbList） -->
<script type="application/ld+json">
${JSON.stringify(breadcrumbSchema, null, 2)}
</script>

<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800;900&family=Noto+Sans+JP:wght@400;500;700;900&family=Zen+Maru+Gothic:wght@400;500;700;900&display=swap');
*{margin:0;padding:0;box-sizing:border-box}
:root{--text:#1d1d1f;--text-sub:#4a5568;--text-mute:#8b96a5;--bg:#fff;--bg-sub:#f7f9fc;--bg-soft:#eef2f7;--primary:#2052c9;--primary-dark:#1a42a8;--primary-light:#4672e1;--primary-soft:#e7eefc;--orange:#f57c2d;--orange-dark:#e06a1a;--orange-soft:#fff2e8;--yellow:#F2C94C;--yellow-soft:#fff8e1;--teal:#5BA89D;--teal-soft:#edf6f4;--pink:#E07B8B;--pink-soft:#fdf2f5;--border:#e1e8ef;--border-light:rgba(0,0,0,.06);--radius-sm:10px;--radius:16px;--radius-lg:24px;--shadow-sm:0 1px 2px rgba(0,0,0,.04);--shadow:0 4px 20px rgba(0,0,0,.06);--shadow-lg:0 24px 48px -20px rgba(32,82,201,.18)}
html{scroll-behavior:smooth}
body{font-family:'Inter','Noto Sans JP',-apple-system,BlinkMacSystemFont,'Helvetica Neue',sans-serif;background:var(--bg-sub);color:var(--text);line-height:1.8;-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;font-feature-settings:"palt"}
::selection{background:var(--primary);color:#fff}
header.site-header{position:sticky;top:0;z-index:100;background:#fff;border-bottom:1px solid var(--border)}
.header-inner{max-width:1280px;margin:0 auto;padding:12px 32px;display:flex;align-items:center;justify-content:space-between;gap:24px}
.logo-area{display:flex;align-items:center;gap:10px;text-decoration:none;flex-shrink:0}
.logo-area img{width:38px;height:38px;border-radius:50%;object-fit:cover}
.logo-block{display:flex;flex-direction:column;line-height:1.1}
.logo-text{font-family:'Zen Maru Gothic',sans-serif;font-weight:900;font-size:1.1rem;color:var(--text);letter-spacing:-.005em}
.logo-text span{color:var(--primary)}
.logo-tagline{font-size:.66rem;color:var(--text-mute);font-weight:500;margin-top:2px}
.header-right{display:flex;align-items:center;gap:20px}
nav.site-nav{display:flex;gap:4px;align-items:center}
nav.site-nav a{text-decoration:none;color:var(--text);font-weight:600;font-size:.88rem;padding:8px 14px;border-radius:8px;transition:color .2s,background .2s}
nav.site-nav a:hover{color:var(--primary);background:var(--primary-soft)}
.header-ctas{display:flex;gap:10px}
.btn-header{display:inline-flex;align-items:center;gap:8px;padding:10px 18px;border-radius:99px;font-size:.85rem;font-weight:700;text-decoration:none;transition:all .2s;white-space:nowrap}
.btn-header.primary{background:var(--primary);color:#fff}
.btn-header.primary:hover{background:var(--primary-dark);transform:translateY(-1px);box-shadow:0 8px 20px rgba(32,82,201,.28)}
.btn-header.orange{background:var(--orange);color:#fff}
.btn-header.orange:hover{background:var(--orange-dark);transform:translateY(-1px);box-shadow:0 8px 20px rgba(245,124,45,.35)}
.btn-header svg{width:14px;height:14px}
.article-wrapper{max-width:820px;margin:32px auto 48px;padding:0 24px}
.back-link{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--text-sub);font-size:.85rem;font-weight:600;margin-bottom:20px;padding:8px 16px;border-radius:99px;background:#fff;border:1px solid var(--border);transition:all .2s}
.back-link:hover{color:var(--primary);border-color:var(--primary);background:var(--primary-soft);transform:translateX(-2px)}
.back-link svg{width:14px;height:14px}
.article-card{background:#fff;border-radius:var(--radius-lg);box-shadow:var(--shadow);overflow:hidden;border:1px solid var(--border-light)}
.article-top-bar{height:4px;background:linear-gradient(90deg,var(--primary),var(--primary-light),var(--orange))}
.article-header-area{padding:44px 48px 28px;border-bottom:1px solid var(--border)}
.article-meta-top{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:20px}
.meta-tag{padding:5px 14px;border-radius:99px;font-weight:700;font-size:.72rem;letter-spacing:.04em}
.meta-category{background:var(--bg-soft);color:var(--text)}
.meta-level.level-beginner{background:var(--teal-soft);color:var(--teal)}
.meta-level.level-intermediate{background:var(--yellow-soft);color:#b88a0f}
.meta-level.level-advanced{background:var(--pink-soft);color:var(--pink)}
.meta-level.level-beginner::before{content:'🐣 '}
.meta-level.level-intermediate::before{content:'🐥 '}
.meta-level.level-advanced::before{content:'🐔 '}
.article-header h1{font-family:'Zen Maru Gothic',sans-serif;font-size:clamp(1.6rem,3.2vw,2.3rem);font-weight:900;line-height:1.45;margin-bottom:20px;letter-spacing:-.01em;color:var(--text);text-wrap:balance;word-break:keep-all}
.article-meta-bottom{display:flex;gap:18px;font-size:.82rem;color:var(--text-mute);flex-wrap:wrap;align-items:center}
.meta-info{display:flex;align-items:center;gap:5px}
.meta-info svg{width:13px;height:13px}
.meta-rating{color:var(--primary);font-weight:800}
.article-body-area{padding:36px 48px 40px}
.article-body{line-height:2;font-size:.98rem;color:var(--text)}
.article-body h1{font-family:'Zen Maru Gothic',sans-serif;font-size:1.35rem;font-weight:900;margin:40px 0 18px;padding:14px 20px;background:var(--primary-soft);border-radius:var(--radius-sm);border-left:4px solid var(--primary);color:var(--text);letter-spacing:-.005em}
.article-body h2{font-family:'Zen Maru Gothic',sans-serif;font-size:1.2rem;font-weight:900;margin:36px 0 16px;padding:12px 18px;background:var(--primary-soft);border-radius:var(--radius-sm);border-left:4px solid var(--primary);color:var(--text);letter-spacing:-.005em}
.article-body h3{font-family:'Zen Maru Gothic',sans-serif;font-size:1.08rem;font-weight:900;margin:30px 0 14px;padding:10px 16px;background:var(--bg-sub);border-radius:var(--radius-sm);border-left:3px solid var(--primary-light);color:var(--text)}
.article-body p{margin-bottom:18px}
.article-body strong,.article-body b{font-weight:800;color:var(--text)}
.article-body em,.article-body i{font-style:italic}
.article-body u{text-decoration:underline;text-decoration-color:var(--primary-light);text-decoration-thickness:2px;text-underline-offset:3px}
.article-body s,.article-body strike,.article-body del{text-decoration:line-through;color:var(--text-mute)}
.article-body .ta-center{text-align:center}
.article-body .ta-right{text-align:right}
.article-body .ta-justify{text-align:justify}
.article-body .ta-left{text-align:left}
.article-body img{max-width:100%;height:auto;border-radius:var(--radius);margin:24px 0;box-shadow:var(--shadow)}
.article-body code{background:var(--primary-soft);color:var(--primary-dark);padding:2px 8px;border-radius:6px;font-size:.88rem;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace}
.article-body pre{background:#0f172a;color:#e0e7ef;padding:20px;border-radius:var(--radius);overflow-x:auto;margin:22px 0;font-size:.85rem;line-height:1.7;font-family:'SF Mono',Menlo,Monaco,Consolas,monospace}
.article-body pre code{background:transparent;color:inherit;padding:0}
.article-body ul,.article-body ol{margin:16px 0 20px 26px}
.article-body li{margin-bottom:8px}
.article-body a{color:var(--primary);font-weight:600;text-decoration:none;border-bottom:1px solid var(--primary-light);transition:background .2s,border-color .2s}
.article-body a:hover{background:var(--primary-soft);border-bottom-color:var(--primary)}
.article-body table{width:100%;border-collapse:collapse;margin:22px 0;font-size:.88rem;border-radius:var(--radius-sm);overflow:hidden;border:1px solid var(--border)}
.article-body th,.article-body td{border:1px solid var(--border);padding:12px 16px;text-align:left}
.article-body th{background:var(--bg-sub);font-weight:700;color:var(--text)}
.article-body blockquote{border-left:4px solid var(--primary);background:var(--primary-soft);padding:16px 22px;margin:22px 0;border-radius:0 var(--radius) var(--radius) 0;font-size:.94rem;color:var(--text-sub)}
.article-body hr{border:none;border-top:1px solid var(--border);margin:36px 0}
.rating-section{background:linear-gradient(135deg,var(--primary) 0%,var(--primary-dark) 100%);color:#fff;padding:40px 48px;text-align:center;position:relative;overflow:hidden}
.rating-section::before{content:'';position:absolute;top:-80px;right:-80px;width:280px;height:280px;background:radial-gradient(circle,rgba(255,255,255,.08),transparent 70%);pointer-events:none}
.rating-section h4{font-size:1.08rem;margin-bottom:6px;font-family:'Zen Maru Gothic',sans-serif;font-weight:900;color:#fff;position:relative;z-index:1}
.rating-section>p{font-size:.88rem;color:rgba(255,255,255,.85);margin-bottom:18px;position:relative;z-index:1}
.star-rating{display:flex;justify-content:center;gap:8px;margin-bottom:18px;position:relative;z-index:1}
.star-btn{background:none;border:none;font-size:2.2rem;cursor:pointer;color:rgba(255,255,255,.3);transition:color .15s,transform .1s}
.star-btn:hover{transform:scale(1.15)}
.star-btn.active{color:var(--yellow)}
.rating-submit{background:var(--orange);color:#fff;border:none;border-radius:99px;padding:12px 32px;font-weight:700;cursor:pointer;transition:transform .2s,background .2s,box-shadow .2s;font-size:.9rem;font-family:inherit;position:relative;z-index:1}
.rating-submit:hover{background:var(--orange-dark);transform:translateY(-2px);box-shadow:0 10px 24px rgba(245,124,45,.4)}
.rating-thanks{display:none;color:#fff;font-weight:700;font-size:.95rem;margin-top:8px;position:relative;z-index:1}
.bottom-nav{padding:24px 48px 28px;text-align:center;background:#fff}
.bottom-nav a{display:inline-flex;align-items:center;gap:6px;text-decoration:none;color:var(--text);font-size:.88rem;font-weight:700;padding:12px 28px;border-radius:99px;border:1px solid var(--border);background:#fff;transition:all .2s}
.bottom-nav a:hover{background:var(--primary-soft);border-color:var(--primary);color:var(--primary);transform:translateX(-2px)}
.bottom-nav a svg{width:14px;height:14px}
footer.site-footer{background:var(--bg-sub);padding:72px 24px 40px;text-align:center;border-top:1px solid var(--border)}
.footer-inner{max-width:960px;margin:0 auto;display:flex;align-items:center;justify-content:center;gap:12px;margin-bottom:24px}
.footer-inner img{width:36px;height:36px;border-radius:50%}
.footer-logo{font-family:'Zen Maru Gothic',sans-serif;font-weight:900;font-size:1.2rem;color:var(--text);letter-spacing:-.005em}
.footer-logo span{color:var(--primary)}
.footer-social{margin:0 0 32px;display:flex;justify-content:center;gap:32px}
.footer-social-item{display:flex;flex-direction:column;align-items:center;gap:8px;text-decoration:none;transition:transform .2s}
.footer-social-item:hover{transform:translateY(-3px)}
.footer-social-icon{display:flex;align-items:center;justify-content:center;width:56px;height:56px;border-radius:50%;background:#fff;border:1px solid var(--border);box-shadow:var(--shadow-sm);overflow:hidden;transition:border-color .2s,box-shadow .2s}
.footer-social-item:hover .footer-social-icon{border-color:var(--primary);box-shadow:0 8px 24px rgba(32,82,201,.18)}
.footer-social-icon svg{width:28px;height:28px;fill:var(--text-sub);transition:fill .2s}
.footer-social-item:hover .footer-social-icon svg{fill:var(--primary)}
.footer-social-icon img{width:100%;height:100%;object-fit:cover}
.footer-social-label{font-size:.72rem;font-weight:700;color:var(--text-sub)}
footer.site-footer p{font-size:.78rem;color:var(--text-mute)}
@media(max-width:960px){.header-right{gap:12px}nav.site-nav{display:none}}
@media(max-width:640px){.header-inner{padding:10px 16px;gap:12px}.logo-area img{width:32px;height:32px}.logo-text{font-size:.98rem}.logo-tagline{font-size:.62rem}.btn-header{padding:8px 14px;font-size:.78rem}.btn-header svg{display:none}.article-wrapper{margin:18px auto 32px;padding:0 14px}.article-header-area{padding:28px 22px 20px}.article-body-area{padding:24px 22px 28px}.article-header h1{font-size:1.3rem}.article-body{font-size:.92rem}.article-body h1,.article-body h2{font-size:1.08rem;padding:10px 14px}.article-body h3{font-size:1rem;padding:8px 12px}.article-body pre{font-size:.8rem;padding:14px}.article-body blockquote{padding:12px 16px;font-size:.88rem}.article-body table{display:block;overflow-x:auto;-webkit-overflow-scrolling:touch;font-size:.82rem}.article-body th,.article-body td{padding:8px 12px;white-space:nowrap}.rating-section{padding:28px 22px}.star-btn{font-size:1.9rem}.bottom-nav{padding:18px 22px 22px}.bottom-nav a{font-size:.84rem;padding:10px 22px}footer.site-footer{padding:56px 16px 32px}.footer-social{gap:20px}.footer-social-icon{width:48px;height:48px}.footer-social-icon svg{width:24px;height:24px}}
</style>
</head>
<body>
<header class="site-header">
  <div class="header-inner">
    <a class="logo-area" href="/">
      <img src="/images/piyo-character.png" alt="Piyo">
      <div class="logo-block">
        <div class="logo-text">Piyo <span>AI</span> Lab</div>
        <div class="logo-tagline">AIを、もっと身近に</div>
      </div>
    </a>
    <div class="header-right">
      <nav class="site-nav">
        <a href="/#articles-section">よみもの</a>
        <a href="/#level-section">レベル</a>
        <a href="/#qa-section">Q&amp;A</a>
      </nav>
      <div class="header-ctas">
        <a href="/#articles-section" class="btn-header primary">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
          記事一覧
        </a>
        <a href="/#qa-section" class="btn-header orange">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          ピヨに質問する
        </a>
      </div>
    </div>
  </div>
</header>

<div class="article-wrapper">
  <a class="back-link" href="/">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
    記事一覧にもどる
  </a>

  <article class="article-card" data-article-id="${escapeAttr(article.id)}">
    <div class="article-top-bar"></div>
    <div class="article-header-area">
      <div class="article-meta-top">
        <span class="meta-tag meta-category">${escapeAttr(article.category || '')}</span>
        <span class="meta-tag meta-level level-${escapeAttr(article.level || '')}">${escapeAttr(article.levelLabel || '')}</span>
      </div>
      <header class="article-header">
        <h1>${escapeAttr(article.title)}</h1>
        <div class="article-meta-bottom">
          <span class="meta-info"><time datetime="${datePublished}">${escapeAttr(article.date || datePublished)}</time></span>
          <span class="meta-info">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
            <span id="views-count">${viewsDisplay}</span>
          </span>
          <span class="meta-rating">&#9733; <span id="rating-avg">${ratingDisplay}</span></span>
        </div>
      </header>
    </div>

    <div class="article-body-area">
      <div class="article-body">
${article.content || ''}
      </div>
    </div>

    <div class="rating-section" id="rating-section">
      <h4>この記事はいかがでしたか？</h4>
      <p>よろしければ評価をお願いします</p>
      <div class="star-rating" id="star-rating">
        <button class="star-btn" data-star="1" aria-label="★1">&#9733;</button>
        <button class="star-btn" data-star="2" aria-label="★2">&#9733;</button>
        <button class="star-btn" data-star="3" aria-label="★3">&#9733;</button>
        <button class="star-btn" data-star="4" aria-label="★4">&#9733;</button>
        <button class="star-btn" data-star="5" aria-label="★5">&#9733;</button>
      </div>
      <button class="rating-submit" id="rating-submit">評価を送信</button>
      <div class="rating-thanks" id="rating-thanks">ご評価ありがとうございます。大変励みになります。</div>
    </div>

    <div class="bottom-nav">
      <a href="/">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        記事一覧にもどる
      </a>
    </div>
  </article>
</div>

<footer class="site-footer">
  <div class="footer-inner">
    <img src="/images/piyo-character.png" alt="Piyo">
    <div class="footer-logo">Piyo <span>AI</span> Lab</div>
  </div>
  <div class="footer-social">
    <a href="https://www.instagram.com/piyoailab?igsh=MWwxMDR3YnZhb3p2YQ%3D%3D&utm_source=qr" target="_blank" rel="noopener noreferrer" class="footer-social-item">
      <div class="footer-social-icon">
        <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2.163c3.204 0 3.584.012 4.85.07 3.252.148 4.771 1.691 4.919 4.919.058 1.265.069 1.645.069 4.849 0 3.205-.012 3.584-.069 4.849-.149 3.225-1.664 4.771-4.919 4.919-1.266.058-1.644.07-4.85.07-3.204 0-3.584-.012-4.849-.07-3.26-.149-4.771-1.699-4.919-4.92-.058-1.265-.07-1.644-.07-4.849 0-3.204.013-3.583.07-4.849.149-3.227 1.664-4.771 4.919-4.919 1.266-.057 1.645-.069 4.849-.069zM12 0C8.741 0 8.333.014 7.053.072 2.695.272.273 2.69.073 7.052.014 8.333 0 8.741 0 12c0 3.259.014 3.668.072 4.948.2 4.358 2.618 6.78 6.98 6.98C8.333 23.986 8.741 24 12 24c3.259 0 3.668-.014 4.948-.072 4.354-.2 6.782-2.618 6.979-6.98.059-1.28.073-1.689.073-4.948 0-3.259-.014-3.667-.072-4.947-.196-4.354-2.617-6.78-6.979-6.98C15.668.014 15.259 0 12 0zm0 5.838a6.162 6.162 0 100 12.324 6.162 6.162 0 000-12.324zM12 16a4 4 0 110-8 4 4 0 010 8zm6.406-11.845a1.44 1.44 0 100 2.881 1.44 1.44 0 000-2.881z"/></svg>
      </div>
      <span class="footer-social-label">Instagram</span>
    </a>
    <a href="https://www.skool.com/tomolab-free" target="_blank" rel="noopener noreferrer" class="footer-social-item">
      <div class="footer-social-icon"><img src="/images/tomo-icon.png" alt="トモラボ"></div>
      <span class="footer-social-label">トモラボ</span>
    </a>
    <a href="https://www.skool.com/tomolab-plus" target="_blank" rel="noopener noreferrer" class="footer-social-item">
      <div class="footer-social-icon"><img src="/images/tomo-plus-icon.png" alt="トモラボ＋"></div>
      <span class="footer-social-label">トモラボ＋</span>
    </a>
  </div>
  <p>&copy; ${new Date().getFullYear()} ${escapeAttr(SITE.name)}. AIの知識をわかりやすくお届けします</p>
</footer>

<script>
(function(){
  var articleId = document.querySelector('.article-card').dataset.articleId;
  var selectedRating = 0;

  // 評価UI
  var stars = document.querySelectorAll('.star-btn');
  var rating = document.getElementById('star-rating');
  var submitBtn = document.getElementById('rating-submit');
  var thanks = document.getElementById('rating-thanks');

  stars.forEach(function(btn){
    btn.addEventListener('mouseenter', function(){
      var v = parseInt(btn.dataset.star);
      stars.forEach(function(s){ s.classList.toggle('active', parseInt(s.dataset.star) <= v); });
    });
    btn.addEventListener('click', function(){
      selectedRating = parseInt(btn.dataset.star);
    });
  });
  rating.addEventListener('mouseleave', function(){
    stars.forEach(function(s){ s.classList.toggle('active', parseInt(s.dataset.star) <= selectedRating); });
  });
  submitBtn.addEventListener('click', async function(){
    if (selectedRating === 0 || !articleId) return;
    try {
      var res = await fetch('/api/rating', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ articleId: articleId, rating: selectedRating })
      });
      if (res.ok) { submitBtn.style.display='none'; thanks.style.display='block'; }
    } catch (e) { console.error(e); alert('評価の送信に失敗しました。もう一度お試しください。'); }
  });

  // 閲覧数+1 → 最新の閲覧数・評価をHTMLに反映
  fetch('/api/views', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({ articleId: articleId })
  }).then(function(r){ return r.json(); }).then(function(data){
    if (!data || !data.success) return;
    var viewsEl = document.getElementById('views-count');
    if (viewsEl && data.views != null) {
      viewsEl.textContent = Number(data.views).toLocaleString();
    }
    var ratingEl = document.getElementById('rating-avg');
    if (ratingEl && Array.isArray(data.ratings) && data.ratings.length > 0) {
      var avg = data.ratings.reduce(function(a,b){return a+b;},0) / data.ratings.length;
      ratingEl.textContent = avg.toFixed(1);
    }
  }).catch(function(){});
})();
</script>
</body>
</html>`;
}

// ===== sitemap.xml 生成 =====
function generateSitemap(summaries) {
  const now = new Date().toISOString().slice(0, 10);
  const urls = [
    `<url><loc>${SITE.url}/</loc><lastmod>${now}</lastmod><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    ...summaries.map(a => {
      const lastmod = a.date || now;
      return `<url><loc>${SITE.url}/article/${a.id}.html</loc><lastmod>${lastmod}</lastmod><changefreq>weekly</changefreq><priority>0.8</priority></url>`;
    }),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join('\n')}
</urlset>`;
}

// ===== robots.txt 生成 =====
function generateRobotsTxt() {
  return `# Piyo AI Lab - robots.txt
User-agent: *
Allow: /
Disallow: /admin.html
Disallow: /api/

# AI クローラー（AEO対策で明示的に許可）
User-agent: GPTBot
Allow: /

User-agent: ChatGPT-User
Allow: /

User-agent: anthropic-ai
Allow: /

User-agent: Claude-Web
Allow: /

User-agent: ClaudeBot
Allow: /

User-agent: PerplexityBot
Allow: /

User-agent: Google-Extended
Allow: /

User-agent: Applebot-Extended
Allow: /

User-agent: Bingbot
Allow: /

Sitemap: ${SITE.url}/sitemap.xml
`;
}

// ===== index.html にメタタグ・JSON-LDを注入 =====
function injectIndexSeo(summaries) {
  const indexPath = 'public/index.html';
  if (!fs.existsSync(indexPath)) return;
  let html = fs.readFileSync(indexPath, 'utf8');

  const websiteSchema = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: SITE.name,
    url: SITE.url,
    description: SITE.description,
    inLanguage: 'ja',
    potentialAction: {
      '@type': 'SearchAction',
      target: { '@type': 'EntryPoint', urlTemplate: `${SITE.url}/?q={search_term_string}` },
      'query-input': 'required name=search_term_string',
    },
  };
  const orgSchema = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: SITE.name,
    url: SITE.url,
    logo: SITE.defaultOgImage,
    description: SITE.description,
  };

  const seoBlock = `
<!-- ===== SEO/AEO Meta（自動生成） ===== -->
<meta name="description" content="${escapeAttr(SITE.description)}">
<meta name="keywords" content="AI,AI初心者,AI活用,AIツール,生成AI,ChatGPT,Claude,Gemini">
<link rel="canonical" href="${SITE.url}/">

<meta property="og:type" content="website">
<meta property="og:title" content="${escapeAttr(SITE.name)} - ${escapeAttr(SITE.description)}">
<meta property="og:description" content="${escapeAttr(SITE.description)}">
<meta property="og:url" content="${SITE.url}/">
<meta property="og:image" content="${SITE.defaultOgImage}">
<meta property="og:site_name" content="${escapeAttr(SITE.name)}">
<meta property="og:locale" content="${SITE.locale}">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${escapeAttr(SITE.name)}">
<meta name="twitter:description" content="${escapeAttr(SITE.description)}">
<meta name="twitter:image" content="${SITE.defaultOgImage}">

<script type="application/ld+json">
${JSON.stringify(websiteSchema)}
</script>
<script type="application/ld+json">
${JSON.stringify(orgSchema)}
</script>
<!-- ===== /SEO Meta ===== -->
`;

  // 既存のSEOブロックを削除
  html = html.replace(/<!-- ===== SEO\/AEO Meta（自動生成） ===== -->[\s\S]*?<!-- ===== \/SEO Meta ===== -->\s*/g, '');
  // </head>の直前に挿入
  html = html.replace(/<\/head>/i, seoBlock + '\n</head>');

  fs.writeFileSync(indexPath, html);
  console.log('🏷️  index.html にSEOメタタグを注入');
}

// ===== article.html にも基本メタを（フォールバックページ用） =====
function injectArticleHtmlSeo() {
  const p = 'public/article.html';
  if (!fs.existsSync(p)) return;
  let html = fs.readFileSync(p, 'utf8');
  const seoBlock = `
<!-- ===== SEO/AEO Meta（自動生成） ===== -->
<meta name="robots" content="noindex,follow">
<!-- 注：このページは旧URL互換のフォールバック。SEO対象は /article/row-N.html 側 -->
<script>
  // 旧URL（/article.html?id=row-N）でアクセスされたら、新URL（/article/row-N.html）へリダイレクト
  (function(){
    var params = new URLSearchParams(window.location.search);
    var id = params.get('id');
    if (id) { window.location.replace('/article/' + encodeURIComponent(id) + '.html'); }
  })();
</script>
<!-- ===== /SEO Meta ===== -->
`;
  html = html.replace(/<!-- ===== SEO\/AEO Meta（自動生成） ===== -->[\s\S]*?<!-- ===== \/SEO Meta ===== -->\s*/g, '');
  html = html.replace(/<\/head>/i, seoBlock + '\n</head>');
  fs.writeFileSync(p, html);
  console.log('🏷️  article.html にnoindex+リダイレクトを注入');
}

// ===== メイン処理 =====
(async () => {
  console.log('🐣 ビルド開始：Google Sheets から記事一覧を取得...');
  copyStaticFiles();

  if (!creds || !SPREADSHEET_ID) {
    console.warn('⚠️  Google認証情報がありません。空のJSONを出力します（ローカル開発時想定）');
    fs.mkdirSync('public/articles', { recursive: true });
    fs.mkdirSync('public/article', { recursive: true });
    fs.writeFileSync('public/articles.json', JSON.stringify({ articles: [], generatedAt: new Date().toISOString() }));
    fs.writeFileSync('public/sitemap.xml', generateSitemap([]));
    fs.writeFileSync('public/robots.txt', generateRobotsTxt());
    return;
  }

  console.log(`🔑 認証OK (service account: ${creds.client_email})`);

  const sheetRes = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: '記事管理!A2:M',
  });
  const rows = sheetRes.data.values || [];
  console.log(`📋 ${rows.length} 行を取得`);

  fs.mkdirSync('public/articles', { recursive: true });
  fs.mkdirSync('public/article', { recursive: true });

  const summaries = [];
  let okCount = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0]) continue;

    const id = `row-${i + 2}`;
    const level = row[3] || '';
    const docId = row[8] || '';

    process.stdout.write(`  [${i + 1}/${rows.length}] ${row[0].slice(0, 30)}... `);
    const content = await getDocContent(docId);
    console.log(content ? `✓ (${content.length}文字)` : '✗');

    const meta = {
      id,
      title: row[0] || '',
      author: row[1] || '',
      category: row[2] || '',
      level,
      levelLabel: getLevelLabel(level),
      excerpt: row[5] || '',
      thumb: row[6] || '',
      thumbImage: upgradeDriveThumbUrl(row[7] || ''),
      date: row[4] || '',
      views: Number(row[9]) || 0,
      ratings: JSON.parse(row[10] || '[]'),
    };
    const article = { ...meta, content };

    // 個別記事JSON
    fs.writeFileSync(`public/articles/${id}.json`, JSON.stringify({ article }));
    // 個別記事の静的HTML（SEO/AEO最適化済）
    fs.writeFileSync(`public/article/${id}.html`, generateArticleHtml(article));

    summaries.push(meta);
    okCount++;
  }

  summaries.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  fs.writeFileSync('public/articles.json',
    JSON.stringify({ articles: summaries, generatedAt: new Date().toISOString() }));

  // sitemap.xml と robots.txt
  fs.writeFileSync('public/sitemap.xml', generateSitemap(summaries));
  fs.writeFileSync('public/robots.txt', generateRobotsTxt());
  console.log('🗺️  sitemap.xml / robots.txt を生成');

  // index.html / article.html にメタタグ注入
  injectIndexSeo(summaries);
  injectArticleHtmlSeo();

  console.log(`✅ 完了：${okCount}件の記事 + 静的HTML + sitemap を public/ に出力しました`);
})().catch(e => {
  console.error('❌ ビルドエラー:', e);
  process.exit(1);
});
