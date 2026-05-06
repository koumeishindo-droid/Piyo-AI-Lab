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
  html = html.replace(/\sclass="[^"]*"/gi, '');
  html = html.replace(/\sid="[^"]*"/gi, '');
  html = html.replace(/href="https:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi,
    (m, url) => 'href="' + decodeURIComponent(url) + '"');
  html = html.replace(/(https:\/\/lh[0-9]*\.googleusercontent\.com\/[^"'\s>]+?)(?:=[^"'\s>]*)?(?=["'\s>])/gi, '$1=w800');
  html = html.replace(/<img([^>]*?)\/?>/gi, (m, attrs) => {
    const src = (attrs.match(/src="([^"]*)"/i) || [])[1] || '';
    const alt = (attrs.match(/alt="([^"]*)"/i) || [])[1] || '';
    return '<img src="' + src + '" alt="' + alt + '" loading="lazy" style="max-width:100%;height:auto;">';
  });
  html = html.replace(/<(?!img)([a-z][a-z0-9]*)([^>]*?)\sstyle="[^"]*"([^>]*)>/gi, '<$1$2$3>');
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
  if (ratings.length >= 1) {
    articleSchema.aggregateRating = {
      '@type': 'AggregateRating',
      ratingValue: avgRating.toFixed(1),
      ratingCount: ratings.length,
      bestRating: 5,
      worstRating: 1,
    };
  }

  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'ホーム', item: SITE.url },
      { '@type': 'ListItem', position: 2, name: article.category || '記事', item: SITE.url + '/?category=' + encodeURIComponent(article.category || '') },
      { '@type': 'ListItem', position: 3, name: article.title, item: url },
    ],
  };

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

<!-- 既存のarticle.htmlへJSでクライアントサイドロード（旧来のUI互換） -->
<script>
  // 静的記事ページにアクセスされた際は、既存のarticle.html?id=... にJSで読み替えてUIを再現
  // ただしクローラーは下のプリレンダリング本文を読むためSEO/AEO効果は維持される
  (function () {
    var id = '${article.id}';
    // クローラー判定（簡易）：UA に bot 系ワードが含まれる場合はリダイレクトしない
    var ua = navigator.userAgent || '';
    var isBot = /bot|crawler|spider|crawling|googlebot|bingbot|chatgpt|gptbot|anthropic|claude|perplexity|youbot|applebot/i.test(ua);
    if (!isBot) {
      // 既存UIを使うため article.html にリダイレクト
      window.location.replace('/article.html?id=' + id);
    }
  })();
</script>
</head>
<body>
<!-- ===== クローラー向けプリレンダリング本文 ===== -->
<header>
  <nav aria-label="パンくず">
    <a href="${SITE.url}/">ホーム</a> &gt;
    <a href="${SITE.url}/?category=${encodeURIComponent(article.category || '')}">${escapeAttr(article.category || '記事')}</a> &gt;
    <span>${escapeAttr(article.title)}</span>
  </nav>
</header>

<main>
  <article>
    <header>
      <p>
        <span>カテゴリ：${escapeAttr(article.category || '')}</span> /
        <span>レベル：${escapeAttr(article.levelLabel || '')}</span>
      </p>
      <h1>${escapeAttr(article.title)}</h1>
      <p>
        <span>公開日：<time datetime="${datePublished}">${escapeAttr(datePublished)}</time></span>
        ${article.author ? ` / <span>著者：${escapeAttr(article.author)}</span>` : ''}
      </p>
      ${article.excerpt ? `<p><strong>${escapeAttr(article.excerpt)}</strong></p>` : ''}
    </header>

    <div>
      ${article.content || ''}
    </div>

    <footer>
      <p>
        <a href="${SITE.url}/">記事一覧にもどる</a>
      </p>
    </footer>
  </article>
</main>

<footer>
  <p>&copy; ${new Date().getFullYear()} ${escapeAttr(SITE.name)} - ${escapeAttr(SITE.description)}</p>
</footer>
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
<!-- 注：このページは記事ローダー。SEO対象は /article/row-N.html 静的ページ側 -->
<!-- ===== /SEO Meta ===== -->
`;
  html = html.replace(/<!-- ===== SEO\/AEO Meta（自動生成） ===== -->[\s\S]*?<!-- ===== \/SEO Meta ===== -->\s*/g, '');
  html = html.replace(/<\/head>/i, seoBlock + '\n</head>');
  fs.writeFileSync(p, html);
  console.log('🏷️  article.html にnoindexメタを注入');
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
      thumbImage: row[7] || '',
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
