'use strict';
/* lib/http.js — 极简 HTTPS GET（只用 Node 内置模块，零第三方依赖）。
   统一超时、JSON 解析、错误信息，供所有 provider 复用。 */
const https = require('https');
const http = require('http');

function request(url, options = {}) {
  const { timeout = 12000, headers = {}, method = 'GET', body = null } = options;
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('地址无效：' + url)); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'http:' ? 80 : 443),
      path: u.pathname + u.search,
      method,
      headers: Object.assign({
        'User-Agent': 'token-quota-widget/0.1',
        'Accept': 'application/json'
      }, headers)
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('HTTP ' + res.statusCode + (text ? ' · ' + text.slice(0, 120) : '')));
        }
        try { resolve(JSON.parse(text)); } catch (e) { resolve(text); }
      });
    });
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

module.exports = { request };
