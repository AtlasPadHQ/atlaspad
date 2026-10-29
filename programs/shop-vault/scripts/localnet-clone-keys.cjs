// Prints the devnet pump fee recipients, buyback recipients and their WSOL ATAs (one per line) for
// scripts/localnet-validator.sh. Read-only RPC. Usage: node scripts/localnet-clone-keys.cjs <rpc>
const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(path.join(__dirname, "../client/package.json"));
const web3 = req("@solana/web3.js");
const pump = req("@pump-fun/pump-sdk");
const spl = req("@solana/spl-token");

(async () => {
  const conn = new web3.Connection(process.argv[2] || "https://api.devnet.solana.com", "confirmed");
  const g = await new pump.OnlinePumpSdk(conn).fetchGlobal();
  const wallets = [g.feeRecipient, ...g.feeRecipients, ...g.buybackFeeRecipients].filter((k) => !k.equals(web3.PublicKey.default));
  const out = new Set();
  for (const w of wallets) {
    out.add(w.toBase58());
    out.add(spl.getAssociatedTokenAddressSync(spl.NATIVE_MINT, w, true, spl.TOKEN_PROGRAM_ID).toBase58());
  }
  console.log([...out].join("\n"));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
