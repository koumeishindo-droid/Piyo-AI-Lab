const { getSheetsClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sheets = getSheetsClient();

  if (req.method === 'POST') {
    try {
      const { name, question } = req.body;

      if (!name || !question) {
        return res.status(400).json({ error: 'お名前と質問内容は必須です' });
      }

      const today = new Date().toISOString().split('T')[0];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: 'QA管理!A:C',
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: {
          values: [[question, name, today]],
        },
      });

      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('質問投稿エラー:', error);
      return res.status(500).json({ error: '質問の投稿に失敗しました' });
    }
  }

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: 'QA管理!A2:C',
    });

    const rows = response.data.values || [];

    const questions = rows
      .filter(row => row[0])
      .map((row, index) => ({
        id: `q-${index + 2}`,
        question: row[0] || '',
        name: row[1] || '',
        date: row[2] || '',
      }));

    questions.sort((a, b) => {
      if (!a.date) return 1;
      if (!b.date) return -1;
      return b.date.localeCompare(a.date);
    });

    res.status(200).json({ questions });
  } catch (error) {
    console.error('Google API エラー:', error);
    res.status(500).json({ error: 'データの取得に失敗しました' });
  }
};
