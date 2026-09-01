// `npm install secrefs` is what people guess. Rather than leave that name
// to a typosquatter - a genuinely dangerous outcome for a package that
// resolves credentials - this is a real, working alias: it depends on
// @secrefs/node and re-exports it wholesale.
export * from "@secrefs/node";
