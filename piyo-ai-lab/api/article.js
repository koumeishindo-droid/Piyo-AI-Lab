// ============================================
// Vercel サーバーレス関数: /api/article
// 指定された1記事のデータ（本文を含む）を取得する
// 記事ページ（article.html）専用の軽量APIです。
// Google Docs上の色・サイズ等の装飾は cleanGoogleDocsHtml で温存します。
// ============================================

const { getSheetsClient, getDriveClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 個別記事を1時間キャッシュ（Vercel CDN）
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const articleId = req.query.id;

    if (!articleId) {
      return res.status(400).json({ error: '記事IDが必要です（例: ?id=row-2）' });
    }

    const rowNumber = parseInt(articleId.replace('row-', ''), 10);
    if (isNaN(rowNumber) || rowNumber < 2) {
      return res.status(400).json({ error: '無効な記事IDです' });
    }

    const sheets = getSheetsClient();

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `記事管理!A${rowNumber}:M${rowNumber}`,
    });

    const rows = response.data.values || [];
    if (!rows.length || !rows[0][0]) {
      return res.status(404).json({ error: '記事が見つかりませんでした' });
    }

    const row = rows[0];
    const docId = row[8] || '';
    let content = '';

    if (docId) {
      content = await getDocContent(docId);
    }

    const level = row[3] || '';

    const article = {
      id: articleId,
      title: row[0] || '',
      author: row[1] || '',
      category: row[2] || '',
      level: level,
      levelLabel: getLevelLabel(level),
      excerpt: row[5] || '',
      content: content,
      thumb: row[6] || '',
      thumbImage: row[7] || '',
      date: row[4] || '',
      views: Number(row[9]) || 0,
      ratings: JSON.parse(row[10] || '[]'),
    };

    res.status(200).json({ article });
  } catch (error) {
    console.error('Google API エラー:', error);
    res.status(500).json({ error: 'データの取得に失敗しました' });
  }
};

// ============================================
// Googleドキュメントの本文をHTML形式で取得
// ============================================

async function getDocContent(docId) {
  try {
    const drive = getDriveClient();

    const response = await drive.files.export({
      fileId: docId,
      mimeType: 'text/html',
    });

    const fullHtml = response.data;

    const bodyMatch = fullHtml.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    let bodyContent = bodyMatch ? bodyMatch[1] : fullHtml;

    bodyContent = cleanGoogleDocsHtml(bodyContent);

    return bodyContent;
  } catch (error) {
    console.error(`ドキュメント取得エラー (ID: ${docId}):`, error.message);
    return '';
  }
}

// ============================================
// Google Docs HTML から温存したいCSSプロパティの許可リスト
// （色・背景色・文字サイズ・太さ・斜体・下線/取り消し線）
// ============================================
const PRESERVE_STYLE_PROPS = [
  'color',
  'background-color',
  'font-size',
  'font-weight',
  'font-style',
  'text-decoration',
];

// <style>タグ内のクラス定義を抽出（例: ".c5{color:#ff0000}" → { c5: "color:#ff0000" }）
function parseClassStyles(html) {
  const result = {};
  const m = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!m) return result;
  const re = /\.([a-zA-Z0-9_-]+)\s*\{([^}]*)\}/g;
  let r;
  while ((r = re.exec(m[1])) !== null) {
    result[r[1]] = r[2];
  }
  return result;
}

// スタイル宣言を許可リストに絞って組み直す
// （font-family や margin といったノイズは捨て、色・サイズなどは残す）
function sanitizeStyle(styleStr) {
  if (!styleStr) return '';
  const kept = {};
  styleStr.split(';').forEach((decl) => {
    const idx = decl.indexOf(':');
    if (idx === -1) return;
    const prop = decl.substring(0, idx).trim().toLowerCase();
    const value = decl.substring(idx + 1).trim();
    if (!PRESERVE_STYLE_PROPS.includes(prop) || !value) return;
    if (prop === 'color' && /^(#000(000)?|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))$/i.test(value)) return;
    if (prop === 'background-color' && /^(transparent|#fff(fff)?|white|rgb\(\s*255\s*,\s*255\s*,\s*255\s*\))$/i.test(value)) return;
    if (prop === 'font-weight' && /^(normal|400)$/i.test(value)) return;
    if (prop === 'font-style' && /^normal$/i.test(value)) return;
    if (prop === 'text-decoration' && /^none$/i.test(value)) return;
    // Google Docsの本文既定サイズ（10〜12pt）はノイズなので捨てる
    if (prop === 'font-size') {
      const numMatch = value.match(/^([\d.]+)\s*pt$/i);
      if (numMatch) {
        const num = parseFloat(numMatch[1]);
        if (num >= 10 && num <= 12) return;
      }
    }
    kept[prop] = value;
  });
  return Object.entries(kept).map(([k, v]) => `${k}:${v}`).join(';');
}

// ============================================
// Google DocsのHTMLをクリーンアップ
// 色・背景色・文字サイズ・太さ/斜体/下線/取消線などの装飾は温存します。
// ============================================

function cleanGoogleDocsHtml(html) {
  // ⓪ <style>からクラス定義を抽出（後で<span>にインライン化するため、削除前に実行）
  const classStyles = parseClassStyles(html);

  // ⓪b 各<span>に、クラス由来＋既存インラインのstyleを合成→sanitize→単一のstyle属性へ
  html = html.replace(/<span\b([^>]*)>/gi, (m, attrs) => {
    const classM = attrs.match(/\sclass="([^"]*)"/i);
    const styleM = attrs.match(/\sstyle="([^"]*)"/i);
    let combined = '';
    if (classM) {
      classM[1].split(/\s+/).forEach((c) => {
        if (classStyles[c]) combined += classStyles[c] + ';';
      });
    }
    if (styleM) combined += styleM[1];
    const sanitized = sanitizeStyle(combined);
    const cleanAttrs = attrs
      .replace(/\sclass="[^"]*"/i, '')
      .replace(/\sstyle="[^"]*"/i, '');
    if (sanitized) return `<span${cleanAttrs} style="${sanitized}">`;
    return `<span${cleanAttrs}>`;
  });

  // ① <style>タグを完全除去（Google Docs既定の大量CSS）
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // ② class属性を除去
  html = html.replace(/\sclass="[^"]*"/gi, '');

  // ③ id属性を除去
  html = html.replace(/\sid="[^"]*"/gi, '');

  // ④ Googleリダイレクトリンクを直リンクに変換
  html = html.replace(
    /href="https:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi,
    (m, url) => 'href="' + decodeURIComponent(url) + '"'
  );

  // ⑤ Google画像URLにサイズ制限を追加（幅800px）
  html = html.replace(
    /(https:\/\/lh[0-9]*\.googleusercontent\.com\/[^"'\s>]+?)(?:=[^"'\s>]*)?(?=["'\s>])/gi,
    '$1=w800'
  );

  // ⑥ 画像タグを再構築（src/altのみ残し、レスポンシブ + 遅延読み込み）
  html = html.replace(
    /<img([^>]*?)\/?>/gi,
    (m, attrs) => {
      const srcMatch = attrs.match(/src="([^"]*)"/i);
      const altMatch = attrs.match(/alt="([^"]*)"/i);
      const src = srcMatch ? srcMatch[1] : '';
      const alt = altMatch ? altMatch[1] : '';
      return '<img src="' + src + '" alt="' + alt + '" loading="lazy" style="max-width:100%;height:auto;">';
    }
  );

  // ⑦ style属性を除去（imgは⑥で再付与済み、spanは⓪bでsanitize済みのため除外）
  html = html.replace(/<(?!img\b|span\b)([a-z][a-z0-9]*)([^>]*?)\sstyle="[^"]*"([^>]*)>/gi, '<$1$2$3>');

  // ⑧ style属性を持たない<span>のみアンラップ（色・サイズ等を持つspanは温存）
  for (let i = 0; i < 5; i++) {
    html = html.replace(/<span(?![^>]*\sstyle=)[^>]*>([\s\S]*?)<\/span>/gi, '$1');
  }

  // ⑨ 空の段落を除去
  html = html.replace(/<p[^>]*>(\s|&nbsp;|<br\s*\/?>)*<\/p>/gi, '');

  // ⑩ 連続する <br> を最大2つまでに制限
  html = html.replace(/(<br\s*\/?>\s*){3,}/gi, '<br><br>');

  // ⑪ 余分な空白行を整理
  html = html.replace(/\n{3,}/g, '\n\n');

  return html;
}

// ============================================
// レベルラベルの変換
// ============================================

function getLevelLabel(level) {
  const labels = {
    beginner: 'ひよこ',
    intermediate: '育ちざかり',
    advanced: 'にわとり',
  };
  return labels[level] || level;
}
