const js = require("@eslint/js");
const globals = require("globals");
const eslintConfigPrettier = require("eslint-config-prettier");

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
        ...globals.commonjs,
      },
    },
    rules: {
      // Logging ke Railway's log stream (console.log/console.error) IS the
      // observability strategy this whole codebase relies on - it's
      // intentional everywhere, not a leftover debug statement.
      "no-console": "off",
    },
  },
  // Harus PALING TERAKHIR - matiin rule stylistic ESLint yang bisa
  // bentrok/dobel sama apa yang Prettier udah urusin (indentasi, kutip,
  // dst). ESLint tetap ngurusin bug-class stuff (unused vars, undef, dll).
  eslintConfigPrettier,
  {
    ignores: ["node_modules/**", "data/**", "backups/**"],
  },
];
