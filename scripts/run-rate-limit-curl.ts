import { execSync } from 'node:child_process';

console.log('--- Executing 10 bad logins against /auth/login ---');
for (let i = 1; i <= 10; i++) {
  const res = execSync(
    'curl.exe -s -o NUL -w "%{http_code}" -X POST http://127.0.0.1:8999/auth/login -H "Content-Type: application/json" -d "{\\"email\\":\\"bad@example.com\\",\\"password\\":\\"bad\\"}"'
  )
    .toString()
    .trim();
  console.log(`Login attempt ${i}: HTTP ${res}`);
}

console.log('\n--- Attempt 11 on /auth/login (expect 429) ---');
const out11 = execSync(
  'curl.exe -i -s -X POST http://127.0.0.1:8999/auth/login -H "Content-Type: application/json" -d "{\\"email\\":\\"bad@example.com\\",\\"password\\":\\"bad\\"}"'
).toString();
console.log(out11);

console.log('\n--- curl -i on /products (expect 200) ---');
const outProd = execSync('curl.exe -i -s http://127.0.0.1:8999/products').toString();
console.log(outProd);
