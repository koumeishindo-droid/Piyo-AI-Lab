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

  // キャッシュ設定: Vercelが1時間（3600秒）レスポンスを保存し、
  // 同じ記事へのアクセスではGoogleへの問い合わせをスキップする
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
// ============================================

function cleanGoogleDocsHtml(html) {
  html = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  html = html.replace(/<span\s*>\s*<\/span>/gi, '');

  // Google画像URLにサイズ制限を追加（幅800px以下に縮小して軽量化）
  html = html.replace(
    /(https:\/\/lh[0-9]*\.googleusercontent\.com\/[^"'\s>]+?)(?:=[^"'\s>]*)?(?=["'\s>])/gi,
    '$1=w800'
  );

  // 画像のスタイルを調整（レスポンシブ対応 + 遅延読み込み）
  html = html.replace(
    /<img([^>]*?)style="([^"]*)"([^>]*?)>/gi,
    '<img$1style="max-width:100%; height:auto;"$3 loading="lazy">'
  );

  html = html.replace(
    /<img(?![^>]*style=)([^>]*?)>/gi,
    '<img style="max-width:100%; height:auto;"$1 loading="lazy">'
  );

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
