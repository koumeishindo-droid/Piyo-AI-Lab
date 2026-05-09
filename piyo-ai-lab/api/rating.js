// ============================================
// Vercel サーバーレス関数: /api/rating
// 読者からの評価を受け取り、Googleスプレッドシートに保存します。
// 同時に「平均評価」「評価数」も自動更新します。
//
// 【Notion版からの変更点】
// ・保存先をNotionからGoogleスプレッドシートに変更
// ・記事の特定にスプレッドシートの行番号を使用
// ============================================

const { getSheetsClient, SPREADSHEET_ID } = require('./_google');

module.exports = async (req, res) => {
  // CORS 設定
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
    const { articleId, rating } = req.body;

    // --- バリデーション ---
    if (!articleId || !rating) {
      return res.status(400).json({ error: '記事IDと評価値が必要です' });
    }
    const ratingNum = Number(rating);
    if (ratingNum < 1 || ratingNum > 5 || !Number.isInteger(ratingNum)) {
      return res.status(400).json({ error: '評価は1〜5の整数で指定してください' });
    }

    // articleId は "row-2" のような形式 → 行番号を取得
    const rowNumber = parseInt(articleId.replace('row-', ''), 10);
    if (isNaN(rowNumber) || rowNumber < 2) {
      return res.status(400).json({ error: '無効な記事IDです' });
    }

    const sheets = getSheetsClient();

    // --- 現在の評価データを取得（K列 = 11列目）---
    const currentData = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `記事管理!K${rowNumber}`,
    });

    const currentRatingsText =
      currentData.data.values && currentData.data.values[0]
        ? currentData.data.values[0][0]
        : '[]';

    let ratings = [];
    try {
      ratings = JSON.parse(currentRatingsText);
      if (!Array.isArray(ratings)) ratings = [];
    } catch {
      ratings = [];
    }

    // --- 新しい評価を追加 ---
    ratings.push(ratingNum);

    // --- 平均と評価数を計算 ---
    const average =
      Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 10) /
      10;
    const count = ratings.length;

    // --- スプレッドシートを更新（K:評価データ、L:平均評価、M:評価数）---
    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: `記事管理!K${rowNumber}:M${rowNumber}`,
      valueInputOption: 'RAW',
      requestBody: {
        values: [[JSON.stringify(ratings), average, count]],
      },
    });

    res.status(200).json({
      success: true,
      average,
      count,
      message: '評価を保存しました',
    });
  } catch (error) {
    console.error('評価の保存エラー:', error);
    res.status(500).json({ error: '評価の保存に失敗しました' });
  }
};
