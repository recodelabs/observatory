export const STYLE = `
:root{--accent:#0b57d0;--fg:#1a1a1a;--bg:#f7f7f7;--card:#fff;--muted:#666;--err:#b3261e}
*{box-sizing:border-box}body{margin:0;font:15px/1.5 system-ui,sans-serif;color:var(--fg);background:var(--bg)}
main{max-width:420px;margin:8vh auto;padding:0 16px}main.wide{max-width:960px}
.card{background:var(--card);border:1px solid #e3e3e3;border-radius:8px;padding:24px}
h1{font-size:20px;margin:0 0 16px}label{display:block;margin:12px 0 4px;color:var(--muted);font-size:13px}
input[type=email],input[type=password],input[type=text]{width:100%;padding:10px;border:1px solid #ccc;border-radius:6px;font:inherit}
button{margin-top:16px;padding:10px 16px;border:0;border-radius:6px;background:var(--accent);color:#fff;font:inherit;cursor:pointer}
button.quiet{background:transparent;color:var(--accent);padding:6px 0}
.msg{padding:10px 12px;border-radius:6px;margin-bottom:12px;background:#eef3ff}.msg.err{background:#fde8e6;color:var(--err)}
table{width:100%;border-collapse:collapse}td,th{text-align:left;padding:8px;border-bottom:1px solid #eee;vertical-align:top}
td form{display:inline}td button{margin:0 4px 0 0;padding:4px 8px;font-size:13px}.muted{color:var(--muted)}
`;
