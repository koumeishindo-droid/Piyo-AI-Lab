// ============================================
// Vercel サーバーレス関数: /api/views
// 記事が開かれたときに閲覧数を+1する
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

    // articleId は "row-2" のような形式 → 行番号を取得
    const rowNumber = parseInt(articleId.replace('row-', ''), 10);
    if (isNaN(rowNumber) || rowNumber < 2) {
      return res.status(400).json({ error: '無効な記事IDです' });
    }

    const sheets = getSheetsClient();

    // 現在の閲覧数を取得（J列 = 10列目）
    const currentData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `記事管理!J${rowNumber}`,
    });

    const currentViews =
      currentData.data.values && currentData.data.values[0]
        ? Number(currentData.data.values[0][0]) || 0
        : 0;

    // 閲覧数を+1して更新
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `記事管理!J${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[currentViews + 1]],
      },
    });

    res.status(200).json({
      success: true,
      views: currentViews + 1,
    });
  } catch (error) {
    console.error('閲覧数更新エラー:', error);
    res.status(500).json({ error: '閲覧数の更新に失敗しました' });
  }
};
