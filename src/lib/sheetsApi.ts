export interface SpreadsheetMetadata {
  spreadsheetId: string;
  spreadsheetUrl: string;
  title: string;
  sheets: Array<{
    sheetId: number;
    title: string;
    rowCount: number;
    columnCount: number;
  }>;
}

export interface SignalLogRecord {
  id: string;
  timestamp: string;
  symbol: string;
  timeframe: string;
  signal: 'BUY' | 'SELL';
  aoPrev: number;
  aoCurr: number;
  price: number;
  pushStatus: string;
  note: string;
  syncedToSheet?: boolean;
}

export function extractSpreadsheetId(input: string): string {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (urlMatch && urlMatch[1]) {
    return urlMatch[1];
  }
  return trimmed;
}

function escapeSheetName(sheetTitle: string): string {
  return `'${sheetTitle.replace(/'/g, "''")}'`;
}

async function parseGoogleError(res: Response): Promise<Error> {
  try {
    const body = await res.json();
    const message =
      body?.error?.message || `Google Sheets API error (${res.status})`;
    const err = new Error(message) as Error & { status?: number };
    err.status = res.status;
    return err;
  } catch {
    const err = new Error(`Google Sheets API error (${res.status})`) as Error & {
      status?: number;
    };
    err.status = res.status;
    return err;
  }
}

export async function getSpreadsheetMetadata(
  accessToken: string,
  spreadsheetId: string
): Promise<SpreadsheetMetadata> {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}?fields=spreadsheetId,spreadsheetUrl,properties.title,sheets.properties`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    throw await parseGoogleError(res);
  }

  const data = await res.json();
  return {
    spreadsheetId: data.spreadsheetId,
    spreadsheetUrl:
      data.spreadsheetUrl ||
      `https://docs.google.com/spreadsheets/d/${data.spreadsheetId}/edit`,
    title: data.properties?.title || 'Untitled Spreadsheet',
    sheets: (data.sheets || []).map((s: any) => ({
      sheetId: s.properties?.sheetId ?? 0,
      title: s.properties?.title || 'Sheet',
      rowCount: s.properties?.gridProperties?.rowCount ?? 1000,
      columnCount: s.properties?.gridProperties?.columnCount ?? 26,
    })),
  };
}

export async function readSheetValues(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  rangeSuffix = 'A1:I200'
): Promise<string[][]> {
  const range = `${escapeSheetName(sheetTitle)}!${rangeSuffix}`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(range)}`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!res.ok) {
    throw await parseGoogleError(res);
  }

  const data = await res.json();
  return (data.values as string[][]) || [];
}

export async function createSignalSpreadsheet(
  accessToken: string,
  title: string
): Promise<SpreadsheetMetadata> {
  const tabName = 'AO_M5_Signals';
  const createRes = await fetch('https://sheets.googleapis.com/v4/spreadsheets', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      properties: {
        title,
      },
      sheets: [
        {
          properties: {
            title: tabName,
            gridProperties: {
              frozenRowCount: 1,
            },
          },
        },
      ],
    }),
  });

  if (!createRes.ok) {
    throw await parseGoogleError(createRes);
  }

  const created = await createRes.json();
  const spreadsheetId = created.spreadsheetId as string;

  const headers = [
    [
      'Timestamp',
      'Symbol',
      'Timeframe',
      'Signal',
      'AO Previous [2]',
      'AO Current [1]',
      'Close Price',
      'Push Notification',
      'Notes',
    ],
  ];

  const writeHeadersRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(
      `${escapeSheetName(tabName)}!A1:I1`
    )}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        values: headers,
      }),
    }
  );

  if (!writeHeadersRes.ok) {
    throw await parseGoogleError(writeHeadersRes);
  }

  return getSpreadsheetMetadata(accessToken, spreadsheetId);
}

export async function appendSignalRows(
  accessToken: string,
  spreadsheetId: string,
  sheetTitle: string,
  records: SignalLogRecord[]
): Promise<number> {
  const values = records.map((r) => [
    r.timestamp,
    r.symbol,
    r.timeframe,
    r.signal,
    r.aoPrev.toFixed(5),
    r.aoCurr.toFixed(5),
    r.price.toString(),
    r.pushStatus,
    r.note,
  ]);

  const range = `${escapeSheetName(sheetTitle)}!A:I`;
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(
      spreadsheetId
    )}/values/${encodeURIComponent(
      range
    )}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ values }),
    }
  );

  if (!res.ok) {
    throw await parseGoogleError(res);
  }

  const data = await res.json();
  return data.updates?.updatedRows ?? records.length;
}
