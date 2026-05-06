// ============================================
// Vercel サーバーレス関数: /api/article
// 指定された1記事のデータ（本文を含む）を取得する
// 記事ページ（article.html）専用の軽量APIです。
// ============================================

const { getSheetsClient, getDriveClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 個別記事を1時間キャッシュ（Vercel CDN）
  // 期限切れ後も60秒間は古いデータを返しつつ裏で更新
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=60');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const articleId = req.query.id;

    if (!articleId) {
      return res.status(400).json({ error: '記事IDが必要です（例: ?id=row-2）' });
    }

    // articleId は "row-2" のような形式 → 行番号を取得
    const rowNumber = parseInt(articleId.replace('row-', ''), 10);
    if (isNaN(rowNumber) || rowNumber < 2) {
      return res.status(400).json({ error: '無効な記事IDです' });
    }

    const sheets = getSheetsClient();

    // 指定行だけを取得（A列〜M列）
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

    // GoogleドキュメントIDがあれば本文をHTMLで取得
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
// Google DocsのHTMLをクリーンアップ
// 不要なラッパー・スタイル・属性を整理して、
// サイトのデザイン（Inter / Noto Sans JP / line-height:2）に
// しっかり馴染むようにします。
// ============================================

function cleanGoogleDocsHtml(html) {
  // ① <style>タグを完全除去（Google Docs既定の大量CSS）
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');

  // ② class属性を除去（"c1" "c2" ...のような一意なクラス名）
  html = html.replace(/\sclass="[^"]*"/gi, '');

  // ③ id属性を除去（"h.abc123" など）
  html = html.replace(/\sid="[^"]*"/gi, '');

  // ④ Googleリダイレクトリンクを直リンクに変換
  html = html.replace(
    /href="https:\/\/www\.google\.com\/url\?q=([^&"]+)[^"]*"/gi,
    (m, url) => 'href="' + decodeURIComponent(url) + '"'
  );

  // ⑤ Google画像URLにサイズ制限を追加（幅800px、軽量化）
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

  // ⑦ すべての style 属性を除去（imgは⑥で再付与済みなので除外）
  html = html.replace(/<(?!img)([a-z][a-z0-9]*)([^>]*?)\sstyle="[^"]*"([^>]*)>/gi, '<$1$2$3>');

  // ⑧ <span>タグをアンラップ（中身だけ残す）
  for (let i = 0; i < 5; i++) {
    html = html.replace(/<span[^>]*>([\s\S]*?)<\/span>/gi, '$1');
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
