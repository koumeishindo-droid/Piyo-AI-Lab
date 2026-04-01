// ============================================
// Vercel サーバーレス関数: /api/questions
// Notion の「Q&A管理」データベースからデータを取得し、
// メインWEB（index.html）に渡す中継役です。
// ※ 回答・ステータス機能なし（質問の受付と一覧表示のみ）
// ============================================

const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const QA_DB_ID = process.env.NOTION_QA_DB_ID;

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // ===== 質問の投稿（POST）=====
  if (req.method === 'POST') {
    try {
      const { name, question } = req.body;

      if (!name || !question) {
        return res.status(400).json({ error: 'お名前と質問内容は必須です' });
      }

      // Notion に新しい質問を追加
      await notion.pages.create({
        parent: { database_id: QA_DB_ID },
        properties: {
          質問内容: {
            title: [{ text: { content: question } }],
          },
          お名前: {
            rich_text: [{ text: { content: name } }],
          },
          日付: {
            date: { start: new Date().toISOString().split('T')[0] },
          },
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
    const response = await notion.databases.query({
      database_id: QA_DB_ID,
      sorts: [{ property: '日付', direction: 'descending' }],
    });

    const questions = response.results.map((page) => {
      const props = page.properties;

      return {
        id: page.id,
        name: getRichText(props['お名前']),
        question: getTitle(props['質問内容']),
        date: getDate(props['日付']),
      };
    });

    res.status(200).json({ questions });
  } catch (error) {
    console.error('Notion API エラー:', error);
    res.status(500).json({ error: 'データの取得に失敗しました' });
  }
};

// ===== 便利関数 =====

function getTitle(prop) {
  if (!prop || !prop.title || !prop.title.length) return '';
  return prop.title.map((t) => t.plain_text).join('');
}

function getRichText(prop) {
  if (!prop || !prop.rich_text || !prop.rich_text.length) return '';
  return prop.rich_text.map((t) => t.plain_text).join('');
}

function getDate(prop) {
  if (!prop || !prop.date || !prop.date.start) return '';
  return prop.date.start;
}
