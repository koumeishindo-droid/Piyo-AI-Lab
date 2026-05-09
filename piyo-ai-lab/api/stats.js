// ============================================
// Vercel サーバーレス関数: /api/stats
// 全記事の最新閲覧数・評価をまとめて返す（軽量・高速）
// ============================================

const { getSheetsClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'public, max-age=30, s-maxage=30, stale-while-revalidate=300');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const sheets = getSheetsClient();

    const result = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: '記事管理!J2:K1000',
    });

    const rows = result.data.values || [];
    const stats = {};

    rows.forEach((row, idx) => {
      const articleId = `row-${idx + 2}`;
      const views = Number(row[0]) || 0;
      const ratingsRaw = (row[1] || '').toString();

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

      stats[articleId] = { views, ratings };
    });

    res.status(200).json({ success: true, stats });
  } catch (error) {
    console.error('stats取得エラー:', error);
    res.status(500).json({ error: '統計の取得に失敗しました' });
  }
};
