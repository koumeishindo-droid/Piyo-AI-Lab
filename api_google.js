const { google } = require('googleapis');

function getAuth(scopes) {
  const credentials = JSON.parse(process.env.GOOGLE_CREDENTIALS);
  return new google.auth.GoogleAuth({
    credentials: {
      client_email: credentials.client_email,
      private_key: credentials.private_key,
    },
    scopes: scopes,
  });
}

function getSheetsClient() {
  const auth = getAuth([
    'https://www.googleapis.com/auth/spreadsheets',
  ]);
  return google.sheets({ version: 'v4', auth });
}

function getDriveClient() {
  const auth = getAuth([
    'https://www.googleapis.com/auth/drive.readonly',
  ]);
  return google.drive({ version: 'v3', auth });
}

const SPREADSHEET_ID = process.env.GOOGLE_SPREADSHEET_ID;

module.exports = {
  getSheetsClient,
  getDriveClient,
  SPREADSHEET_ID,
};
