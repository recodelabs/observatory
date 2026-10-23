// The gate's own pages (sign-in, sign-up, Settings) look like the dashboards they guard: the
// colours, fonts, cards and tables of Observable Framework's light theme with "alt" (grey page,
// white cards). The variables are Framework's own names, so a page can be read against
// Framework's theme CSS; --theme-foreground-focus is the brand accent (links, focus rings).
export const STYLE = `
:root{--serif:"Source Serif 4","Iowan Old Style","Apple Garamond","Palatino Linotype","Times New Roman",Times,serif;
  --sans-serif:-apple-system,BlinkMacSystemFont,"avenir next",avenir,helvetica,"helvetica neue",ubuntu,roboto,noto,"segoe ui",arial,sans-serif;
  --theme-foreground:#1b1e23;--theme-foreground-focus:#3b5fc0;--theme-background-a:#fff;
  --theme-background-b:color-mix(in srgb,var(--theme-foreground) 4%,var(--theme-background-a));
  --theme-foreground-alt:color-mix(in srgb,var(--theme-foreground) 90%,var(--theme-background-a));
  --theme-foreground-muted:color-mix(in srgb,var(--theme-foreground) 60%,var(--theme-background-a));
  --theme-foreground-fainter:color-mix(in srgb,var(--theme-foreground) 30%,var(--theme-background-a));
  --theme-foreground-faintest:color-mix(in srgb,var(--theme-foreground) 14%,var(--theme-background-a));
  --theme-blue:#4269d0;--theme-green:#3ca951;--theme-yellow:#efb118;--theme-red:#ff725c;--danger:#c4402a;
  color-scheme:light}
*{box-sizing:border-box}
html{background:var(--theme-background-b);color:var(--theme-foreground);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
body{margin:0;background:var(--theme-background-b);font:17px/1.5 var(--serif)}
.shell{max-width:440px;margin:0 auto;padding:12vh 16px 4rem}.shell.wide{max-width:1152px;padding-top:1.5rem}
a[href]{color:var(--theme-foreground-focus);text-decoration:none}a[href]:hover{text-decoration:underline}
:focus-visible{outline:2px solid var(--theme-foreground-focus);outline-offset:2px}
nav.top{display:flex;justify-content:space-between;align-items:center;gap:.5rem 1rem;flex-wrap:wrap;margin-bottom:2.5rem;
  font:14px var(--sans-serif);color:var(--theme-foreground-muted)}
nav.top .who{display:flex;gap:.25rem .75rem;align-items:center;flex-wrap:wrap;min-width:0}nav.top .email{min-width:0;overflow-wrap:anywhere}
h1,h2,h3{color:var(--theme-foreground-alt);font-weight:700;line-height:1.15;margin:0 0 .25rem;text-wrap:balance}
h1{font-size:34px;margin-bottom:1.5rem}h1:has(+h2){margin-bottom:.25rem}h1 a[href]{color:inherit}h1 a[href]:hover{text-decoration:none}
h1+h2{color:var(--theme-foreground);font-size:20px;font-style:italic;font-weight:400;margin-bottom:1.5rem}
h3{font:700 14px/1.3 var(--sans-serif);color:var(--theme-foreground);margin:0 0 .75rem}
.logo{display:block;height:88px;max-width:100%;margin-bottom:1.25rem}
p{max-width:640px;margin:0 0 1rem}
.card{background:var(--theme-background-a);border:1px solid var(--theme-foreground-faintest);border-radius:.75rem;padding:1rem 1.25rem 1.25rem;
  margin:0 0 1rem;font:14px/1.5 var(--sans-serif)}
.card p{font:inherit;margin:.75rem 0 0}.card>:first-child{margin-top:0}.card ul{margin:.5rem 0 0;padding-left:1.25rem}
.note{font:13px/1.5 var(--sans-serif);color:var(--theme-foreground-muted);max-width:640px}
.muted{color:var(--theme-foreground-muted)}
label{display:block;margin:.75rem 0 .25rem;font:13px var(--sans-serif);color:var(--theme-foreground-muted)}
form>input[type=hidden]:first-child+label{margin-top:0}
input[type=email],input[type=password],input[type=text]{width:100%;padding:.45rem .6rem;font:14px var(--sans-serif);color:var(--theme-foreground);
  background:var(--theme-background-a);border:1px solid var(--theme-foreground-fainter);border-radius:6px}
input[type=email]:focus,input[type=password]:focus,input[type=text]:focus{outline:none;border-color:var(--theme-foreground-focus);
  box-shadow:0 0 0 3px color-mix(in srgb,var(--theme-foreground-focus) 20%,transparent)}
input[type=checkbox]{accent-color:var(--theme-blue);margin:0}
button{font:500 14px var(--sans-serif);padding:.45rem .9rem;border-radius:6px;cursor:pointer;color:var(--theme-foreground);
  background:var(--theme-background-a);border:1px solid var(--theme-foreground-fainter)}
button:hover{border-color:var(--theme-foreground-muted)}
button.primary{color:var(--theme-background-a);background:var(--theme-foreground);border-color:var(--theme-foreground)}
button.primary:hover{background:var(--theme-foreground-alt)}
button.link{border:0;background:none;padding:0;font-weight:400;color:var(--theme-foreground-focus)}
button.link:hover{text-decoration:underline}button.link.danger{color:var(--danger)}
form{margin:0}.actions{display:flex;gap:.75rem 1rem;align-items:center;flex-wrap:wrap;margin-top:1rem}
.full{width:100%}
.or{display:flex;align-items:center;gap:.75rem;margin:1rem 0;font:13px var(--sans-serif);color:var(--theme-foreground-muted)}
.or::before,.or::after{content:"";flex:1;border-top:1px solid var(--theme-foreground-faintest)}
.msg{margin:0 0 1rem;padding:.75rem 1rem;font:14px/1.5 var(--sans-serif);border-left:2px solid var(--theme-blue);
  background:color-mix(in srgb,var(--theme-blue) 6%,var(--theme-background-a))}
.msg.err{border-left-color:var(--theme-red);background:color-mix(in srgb,var(--theme-red) 8%,var(--theme-background-a))}
.row{display:flex;gap:0 1rem;flex-wrap:wrap}.row>div{flex:1 1 220px}
.checks{display:flex;gap:.25rem 1.25rem;flex-wrap:wrap}
label.check{display:inline-flex;gap:.4rem;align-items:center;margin:.25rem 0;font-size:14px;color:var(--theme-foreground)}
.scroll{overflow-x:auto}
table{width:100%;border-collapse:collapse;font:13px/1.3 var(--sans-serif);font-variant-numeric:tabular-nums}
th{color:var(--theme-foreground);text-align:left;vertical-align:bottom;font-weight:600}
td{color:var(--theme-foreground-alt);vertical-align:top}
th,td{padding:.55rem .9rem .55rem 0}th:last-child,td:last-child{padding-right:0}
thead tr{border-bottom:1px solid var(--theme-foreground-fainter)}tbody tr:not(:last-child){border-bottom:1px solid var(--theme-foreground-faintest)}
td .sub{display:block;margin-top:.15rem;color:var(--theme-foreground-muted)}
td.date{white-space:nowrap}
td form.sites{display:flex;gap:.1rem .9rem;flex-wrap:wrap;align-items:center}td form.sites label.check{margin:0;font-size:13px}td form.sites .saved{font-size:12px}
td .acts{display:flex;gap:.25rem .9rem;flex-wrap:wrap}td .acts button{font-size:13px}
.status{white-space:nowrap}.status::before{content:"";display:inline-block;width:.5rem;height:.5rem;border-radius:50%;margin-right:.4rem;
  background:var(--theme-foreground-fainter);vertical-align:.05em}
.status.active::before{background:var(--theme-green)}.status.pending::before{background:var(--theme-yellow)}.status.disabled::before{background:var(--theme-red)}
`;
