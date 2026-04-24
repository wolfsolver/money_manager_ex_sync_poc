// Definizione delle tabelle da sincronizzare e dei campi da monitorare per il trigger
export const SYNC_CONFIG = {
    'INFOTABLE_V1': { pk: 'INFOID', fields: ['INFONAME', 'INFOVALUE'] },
    'CATEGORY_V1': { pk: 'CATEGID', fields: ['CATEGNAME', 'ACTIVE', 'PARENTID'] },
    'PAYEE_V1': { pk: 'PAYEEID', fields: ['PAYEENAME', 'ACTIVE', 'CATEGID'] },
    'ACCOUNTLIST_V1': { pk: 'ACCOUNTID', fields: ['ACCOUNTNAME', 'ACCOUNTTYPE', 'STATUS', 'FAVORITEACCT', 'INITIALDATE', 'INITIALBAL', 'CURRENCYID'] },
    'CHECKINGACCOUNT_V1': { pk: 'TRANSID', fields: ['ACCOUNTID', 'TOACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'STATUS', 'CATEGID', 'TRANSDATE', 'NOTES'] },
    'BILLSDEPOSITS_V1': { pk: 'BDID', fields: ['ACCOUNTID', 'PAYEEID', 'TRANSCODE', 'TRANSAMOUNT', 'CATEGID', 'NEXTOCCURRENCEDATE'] },
    //    'BUDGETSPLITTRANSACTIONS_V1': { pk: 'SPLITTRANSID', fields: ['TRANSID', 'CATEGID', 'SPLITTRANSAMOUNT'] }
};

// Ordine di sincronizzazione per rispettare le Foreign Keys
export const SYNC_ORDER = [
    'INFOTABLE_V1',
    'CATEGORY_V1',
    'PAYEE_V1',
    'ACCOUNTLIST_V1',
    'CHECKINGACCOUNT_V1',
    'BILLSDEPOSITS_V1',
    //    'BUDGETSPLITTRANSACTIONS_V1'
];