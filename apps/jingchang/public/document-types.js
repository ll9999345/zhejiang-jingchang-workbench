export const DOCUMENT_LIMIT=20*1024*1024;
export const DOCUMENT_EXTENSIONS=['txt','md','markdown','json','csv','log','py','js','ts','tsx','jsx','html','css','xml','yaml','yml','docx','xlsx'];
export const DOCX_MIME='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const XLSX_MIME='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const documentKind=name=>{const ext=String(name||'').split('.').at(-1).toLowerCase();return DOCUMENT_EXTENSIONS.includes(ext)?(['docx','xlsx'].includes(ext)?ext:'text'):null;};
export const documentMime=name=>({docx:DOCX_MIME,xlsx:XLSX_MIME,text:'text/plain'})[documentKind(name)];
export const isDocument=a=>!!a&&!!documentKind(a.name)&&['text/plain','application/json',DOCX_MIME,XLSX_MIME].includes(a.type);
export const DOCUMENT_ACCEPT=DOCUMENT_EXTENSIONS.map(x=>'.'+x).join(',');
