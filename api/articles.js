// ============================================
// Vercel サーバーレス関数: /api/articles
// Notion の「記事管理」データベースからデータを取得し、
// メインWEB（index.html）に渡す中継役です。
// ============================================

const { Client } = require('@notionhq/client');

const notion = new Client({ auth: process.env.NOTION_API_KEY });
const ARTICLES_DB_ID = process.env.NOTION_ARTICLES_DB_ID;

module.exports = async (req, res) => {
  // どのドメインからでもデータを取得できるようにする設定
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    // Notion データベースから記事一覧を取得
    const response = await notion.databases.query({
      database_id: ARTICLES_DB_ID,
      sorts: [{ property: '日付', direction: 'descending' }],
    });

    // Notion のデータを、メインWEB で使いやすい形に変換
    const articles = response.results.map((page) => {
      const props = page.properties;

      return {
        id: page.id,
        title: getTitle(props['タイトル']),
        author: getRichText(props['執筆者']),
        category: getMultiSelect(props['カテゴリ']),
        level: getMultiSelect(props['レベル']),
        levelLabel: getLevelLabel(getMultiSelect(props['レベル'])),
        excerpt: getRichText(props['概要']),
        content: getRichText(props['本文']),
        thumb: getRichText(props['サムネイル背景']),
        thumbImage: getUrl(props['サムネイル画像']),
        date: getDate(props['日付']),
        views: getNumber(props['閲覧数']),
        ratings: JSON.parse(getRichText(props['評価データ']) || '[]'),
      };
    });

    res.status(200).json({ articles });
  } catch (error) {
    console.error('Notion API エラー:', error);
    res.status(500).json({ error: 'データの取得に失敗しました' });
  }
};

// ===== Notion プロパティから値を取り出すための便利関数 =====

function getTitle(prop) {
  if (!prop || !prop.title || !prop.title.length) return '';
  return prop.title.map((t) => t.plain_text).join('');
}

function getRichText(prop) {
  if (!prop || !prop.rich_text || !prop.rich_text.length) return '';
  return prop.rich_text.map((t) => t.plain_text).join('');
}

function getSelect(prop) {
  if (!prop || !prop.select) return '';
  return prop.select.name || '';
}

function getMultiSelect(prop) {
  if (!prop || !prop.multi_select || !prop.multi_select.length) return '';
  // マルチセレクトの最初の値を使用（カテゴリ・レベルは1つだけ選ぶ想定）
  return prop.multi_select[0].name || '';
}

function getDate(prop) {
  if (!prop || !prop.date || !prop.date.start) return '';
  return prop.date.start;
}

function getNumber(prop) {
  if (!prop || prop.number === null || prop.number === undefined) return 0;
  return prop.number;
}

function getUrl(prop) {
  if (!prop || !prop.url) return '';
  return prop.url;
}

function getLevelLabel(level) {
  const labels = {
    beginner: 'ひよこ',
    intermediate: '育ちざかり',
    advanced: 'にわとり',
  };
  return labels[level] || level;
}
