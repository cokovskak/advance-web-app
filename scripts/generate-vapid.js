// Generates a VAPID key pair and prints lines you can paste into .env.
// Usage:  npm run gen-keys

let webpush;
try {
  webpush = require("web-push");
} catch (_) {
  console.error("Missing dependency. Run:  npm install");
  process.exit(1);
}

const { publicKey, privateKey } = webpush.generateVAPIDKeys();
console.log("# Paste into .env:");
console.log(`VAPID_PUBLIC_KEY=${publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${privateKey}`);
console.log("VAPID_SUBJECT=mailto:admin@example.com");
