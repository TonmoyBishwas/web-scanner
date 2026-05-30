/**
 * Airtable REST API client for issue operations.
 * Uses fetch-based calls (no heavy library).
 */

const AIRTABLE_TOKEN = process.env.AIRTABLE_TOKEN!;
const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID!;
const BOX_INVENTORY_TABLE_ID = process.env.AIRTABLE_BOX_INVENTORY_TABLE_ID!;
const TRANSACTIONS_TABLE_ID = process.env.AIRTABLE_TRANSACTIONS_TABLE_ID!;
const INVENTORY_TABLE_ID = process.env.AIRTABLE_INVENTORY_TABLE_ID!;

const AIRTABLE_API = 'https://api.airtable.com/v0';

async function airtableFetch(
  tableId: string,
  path: string = '',
  options: RequestInit = {}
) {
  const url = `${AIRTABLE_API}/${AIRTABLE_BASE_ID}/${tableId}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${AIRTABLE_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Airtable API error ${res.status}: ${errorText}`);
  }

  return res.json();
}

/**
 * Find a box in Box Inventory by barcode.
 */
export async function findBoxByBarcode(barcode: string) {
  const formula = encodeURIComponent(`{Barcode}="${barcode}"`);
  const data = await airtableFetch(
    BOX_INVENTORY_TABLE_ID,
    `?filterByFormula=${formula}&maxRecords=1`
  );

  if (!data.records || data.records.length === 0) {
    return null;
  }

  const record = data.records[0];
  return {
    record_id: record.id,
    fields: record.fields,
    createdTime: record.createdTime,
  };
}

/**
 * Get an inventory batch record by ID.
 */
export async function getInventoryRecord(recordId: string) {
  const data = await airtableFetch(INVENTORY_TABLE_ID, `/${recordId}`);
  return {
    record_id: data.id,
    fields: data.fields,
  };
}

/**
 * Mark a box as issued in Box Inventory.
 */
export async function issueBox(boxRecordId: string, transactionId: string) {
  const issuedDate = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
  const data = await airtableFetch(BOX_INVENTORY_TABLE_ID, `/${boxRecordId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        Status: 'Issued',
        'Issued Date': issuedDate,
        'Transaction ID': transactionId,
      },
    }),
  });
  return data;
}

/**
 * Revert a box issue (set back to Available).
 */
export async function revertBoxIssue(boxRecordId: string) {
  const data = await airtableFetch(BOX_INVENTORY_TABLE_ID, `/${boxRecordId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        Status: 'Available',
        'Issued Date': null,
        'Transaction ID': null,
      },
    }),
  });
  return data;
}

/**
 * Create an OUT transaction in the Transactions table.
 */
export async function createIssueTransaction(params: {
  itemCode: string;
  itemNameEnglish: string;
  itemNameHebrew: string;
  supplierEnglish: string;
  supplierHebrew: string;
  quantity: number;
  batchId: string;
  boxBarcode: string;
  chatId: string;
}) {
  const data = await airtableFetch(TRANSACTIONS_TABLE_ID, '', {
    method: 'POST',
    body: JSON.stringify({
      fields: {
        Type: 'OUT',
        'Item Code': params.itemCode,
        'Item Name English': params.itemNameEnglish,
        'Item Name Hebrew': params.itemNameHebrew,
        'Supplier English': params.supplierEnglish,
        'Supplier Hebrew': params.supplierHebrew,
        'Quantity KG': params.quantity,
        'Document Number': `ISSUE-${params.boxBarcode.slice(0, 8)}`,
        'Chat ID': params.chatId,
        'Batch ID': params.batchId,
        'Is Undone': false,
        'Box Barcode': params.boxBarcode,
      },
    }),
  });
  return {
    transaction_id: data.id,
    fields: data.fields,
  };
}

/**
 * Decrement inventory batch quantity.
 */
export async function updateInventoryQuantity(
  batchId: string,
  quantityToSubtract: number
) {
  // First get current quantity
  const record = await getInventoryRecord(batchId);
  const currentQty = record.fields['Quantity KG'] || 0;
  const newQty = currentQty - quantityToSubtract;

  const data = await airtableFetch(INVENTORY_TABLE_ID, `/${batchId}`, {
    method: 'PATCH',
    body: JSON.stringify({
      fields: {
        'Quantity KG': newQty,
      },
    }),
  });
  return {
    previous_quantity: currentQty,
    new_quantity: newQty,
    fields: data.fields,
  };
}
