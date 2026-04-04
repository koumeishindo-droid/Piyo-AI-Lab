// ============================================
// Vercel サーバーレス関数: /api/questions
// Google スプレッドシートの「Q&A管理」シートからデータを取得し、
// メインWEB（index.html）に渡す中継役です。
// 質問の受付（POST）と一覧表示（GET）に対応。
//
// 【Notion版からの変更点】
// ・データソースをNotionからGoogleスプレッドシートに変更
// ============================================

const { getSheetsClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const sheets = getSheetsClient();

  // ===== 質問の投稿（POST）=====
  if (req.method === 'POST') {
    try {
      const { name, question } = req.body;

      if (!name || !question) {
        return res.status(400).json({ error: 'お名前と質問内容は必須です' });
      }

      // スプレッドシートの「Q&A管理」シートに新しい行を追加
      const today = new Date().toISOString().split('T')[0];

      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
       range: 'QA管理!A:C'
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

  // ===== 質問一覧の取得（GET）=====
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
     range: 'QA管理!A2:C' // ヘッダー行を除いた2行目以降
    });

    const rows = response.data.values || [];

    // スプレッドシートの列構成:
    // A:質問内容 B:お名前 C:日付
    const questions = rows
      .filter(row => row[0]) // 質問内容が空の行はスキップ
      .map((row, index) => ({
        id: `q-${index + 2}`,
        question: row[0] || '',
        name: row[1] || '',
        date: row[2] || '',
      }));

    // 日付の降順でソート（新しい質問が先）
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
