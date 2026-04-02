const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });

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

    // --- 現在の評価データを取得 ---
    const page = await notion.pages.retrieve({ page_id: articleId });
    const currentRatingsText =
      page.properties['評価データ'] &&
      page.properties['評価データ'].rich_text &&
      page.properties['評価データ'].rich_text.length
        ? page.properties['評価データ'].rich_text
            .map((t) => t.plain_text)
            .join('')
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

    // --- Notion ページを更新 ---
    await notion.pages.update({
      page_id: articleId,
      properties: {
        // 評価の生データ（JSON配列）
        評価データ: {
          rich_text: [
            {
              type: 'text',
              text: { content: JSON.stringify(ratings) },
            },
          ],
        },
        // Notion 上で直接見える「平均評価」（数値プロパティ）
        平均評価: {
          number: average,
        },
        // Notion 上で直接見える「評価数」（数値プロパティ）
        評価数: {
          number: count,
        },
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
