// A one-site Observatory project on a local, made-up warehouse. `npm run warehouse` makes it;
// `npm run dev` previews the site. Deploying needs a real bucket and rclone remote.
export default {
  host: "http://localhost:3000",
  cloudflare: {bucket: "observatory-demo", rclone: "r2", sites: "_site/demo/"},
  warehouses: {
    demo: {r2: "demo/", local: "warehouse"}
  },
  sites: [
    {name: "demo", path: "/", dir: "sites/demo", warehouse: "demo", access: "public"}
  ]
};
