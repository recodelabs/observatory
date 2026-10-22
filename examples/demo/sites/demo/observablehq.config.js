// An Observatory site: an Observable Framework project whose data loaders read a warehouse.
// `observatory dev <site>` previews it and `observatory deploy <site>` publishes it; both set
// DATA to the warehouse folder (parquet/, tiles/, manifest.json) the loaders read.
// https://observablehq.com/framework/config
export default {
  title: "Dashboards",
  root: "src",
  pages: [
    {name: "Overview", path: "/"}
  ],
  sidebar: true,
  toc: false,
  pager: false,
  // The search index holds the text of every page; leave it off on sites that need sign-in.
  search: false,
  theme: ["light", "alt"],
  cleanUrls: true,
  // DuckDB 2.0 (which observatory puts in) has json and parquet built in; don't bundle Framework's 1.1.1 ones.
  duckdb: {extensions: {json: null, parquet: null}}
};
