// ============================================
// Vercel サーバーレス関数: /api/views
// 記事が開かれたときに閲覧数を+1し、最新の閲覧数・評価を返す
// ============================================

const { getSheetsClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST のみ受け付けています' });
  }

  try {
    const { articleId } = req.body;

    if (!articleId) {
      return res.status(400).json({ error: '記事IDが必要です' });
    }

    const rowNumber = parseInt(articleId.replace('row-', ''), 10);
    if (isNaN(rowNumber) || rowNumber < 2) {
      return res.status(400).json({ error: '無効な記事IDです' });
    }

    const sheets = getSheetsClient();

    // J列（閲覧数）と K列（評価データ）を一度に取得
    const currentData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `記事管理!J${rowNumber}:K${rowNumber}`,
    });

    const row = (currentData.data.values && currentData.data.values[0]) || [];
    const currentViews = Number(row[0]) || 0;
    const ratingsRaw = row[1] || '';

    // 評価データをパース（カンマ or JSON配列形式に対応）
    let ratings = [];
    try {
      if (ratingsRaw.trim().startsWith('[')) {
        ratings = JSON.parse(ratingsRaw);
      } else if (ratingsRaw.trim()) {
        ratings = ratingsRaw.split(',').map(s => Number(s.trim())).filter(n => !isNaN(n));
      }
    } catch (e) {
      ratings = [];
    }

    // 閲覧数を+1して更新
    const newViews = currentViews + 1;
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `記事管理!J${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[newViews]],
      },
    });

    res.status(200).json({
      success: true,
      views: newViews,
      ratings: ratings,
    });
  } catch (error) {
    console.error('閲覧数更新エラー:', error);
    res.status(500).json({ error: '閲覧数の更新に失敗しました' });
  }
};
