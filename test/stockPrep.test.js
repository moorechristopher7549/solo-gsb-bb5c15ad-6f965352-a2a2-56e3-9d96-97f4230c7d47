'use strict';

/**
 * 印刷备料（stock preparation）单元测试：
 * - 未启用时响应完全不变（顶层仅 { enabled: false }，帖对象无字段）；
 * - 逐帖净用纸 / 开机损耗 / 过程损耗 / 需领纸公式与逐帖 ceil 取整；
 * - 关键约束：逐帖取整后再汇总（与「先合并各帖再算损耗」口径不同时，必须取逐帖口径）；
 * - 汇总后按每包张数向上取整采购；
 * - 固定 / 均衡 / 章节优先分帖均按各帖实际张数计算；
 * - 非法参数（份数 / 开机损耗 / 损耗率 / 每包张数 / 开关类型）抛明确错误。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../server');
const { computeImposition } = require('../src/imposition');
const { computeSignatureStock } = require('../src/stockPrep');

const BASE = { totalPages: 8, sheetsPerSignature: 2, binding: 'left', flip: 'short' };

function withStock(extra) {
  return {
    stockPreparation: true,
    copies: 100,
    makereadyWaste: 20,
    processWasteRate: 0.05,
    sheetsPerPack: 500,
    ...extra,
  };
}

test('未启用：顶层仅 { enabled: false }，帖对象不带任何备料字段，input 也不含备料参数', () => {
  const r = computeImposition({ ...BASE });
  assert.deepEqual(r.stockPreparation, { enabled: false });
  r.signatures.forEach((sig) => assert.equal(sig.stockPreparation, undefined));
  assert.equal(r.input.stockPreparation, undefined);
  assert.equal(r.input.copies, undefined);
});

test('显式 false / 空参数同样不启用', () => {
  const r = computeImposition({ ...BASE, stockPreparation: false, copies: 100 });
  assert.deepEqual(r.stockPreparation, { enabled: false });
  assert.equal(r.signatures[0].stockPreparation, undefined);
});

test('单帖：净用纸 = 实际张数 × 份数；需领纸 = ceil((净用纸+开机损耗)/(1-损耗率))', () => {
  const r = computeImposition({ ...BASE, ...withStock() });
  const sp = r.stockPreparation;
  assert.equal(sp.enabled, true);
  assert.equal(sp.signatures.length, 1);
  const d = sp.signatures[0];
  assert.equal(d.actualSheetCount, 2);
  assert.equal(d.netSheets, 200); // 2 张 × 100 份
  assert.equal(d.makereadyWasteSheets, 20);
  assert.equal(d.requiredSheets, 232); // ceil(220 / 0.95) = ceil(231.5789)
  assert.equal(d.processWasteSheets, 12); // 232 - 200 - 20
  assert.equal(d.wasteSheets, 32);
  // 汇总
  assert.equal(sp.totalNetSheets, 200);
  assert.equal(sp.totalMakereadyWaste, 20);
  assert.equal(sp.totalProcessWaste, 12);
  assert.equal(sp.totalWaste, 32);
  assert.equal(sp.totalRequired, 232);
  // 整包采购：ceil(232 / 500) = 1 包 = 500 张
  assert.equal(sp.packsToBuy, 1);
  assert.equal(sp.sheetsToBuy, 500);
  assert.equal(sp.spareSheets, 268);
  // 同一明细写入帖对象（导出 JSON 与页面逐帖展示使用同一份数据）
  assert.deepEqual(r.signatures[0].stockPreparation, d);
  // input 回显备料参数（供试印核验重算复用）
  assert.equal(r.input.stockPreparation, true);
  assert.equal(r.input.copies, 100);
  assert.equal(r.input.makereadyWaste, 20);
  assert.equal(r.input.processWasteRate, 0.05);
  assert.equal(r.input.sheetsPerPack, 500);
});

test('损耗率为 0：需领纸 = 净用纸 + 开机损耗', () => {
  const r = computeImposition({ ...BASE, ...withStock({ processWasteRate: 0 }) });
  const d = r.stockPreparation.signatures[0];
  assert.equal(d.netSheets, 200);
  assert.equal(d.requiredSheets, 220);
  assert.equal(d.processWasteSheets, 0);
  assert.equal(d.wasteSheets, 20);
});

test('过程损耗率数学上恰为整数时不多 ceil 一张（浮点尾数吸收）', () => {
  // 190 / (1 - 0.05) = 200 恰为整数
  const d = computeSignatureStock(1, 2, { copies: 95, makereadyWaste: 0, processWasteRate: 0.05 });
  assert.equal(d.netSheets, 190);
  assert.equal(d.requiredSheets, 200);
});

test('多帖：逐帖独立 ceil 后再汇总，禁止先合并各帖再计算损耗', () => {
  // 16 页、每帖 2 张 => 2 帖，各 2 张；100 份，开机 20，损耗率 10%。
  // 逐帖：ceil(220 / 0.9) = ceil(244.444) = 245；两帖合计 490。
  // 若错误地先合并：ceil((400 + 40) / 0.9) = ceil(488.888) = 489（少领 1 张）。
  const merged = Math.ceil((400 + 40) / 0.9);
  assert.equal(merged, 489); // 前置：两种口径在该用例下确实不同
  const r = computeImposition({
    totalPages: 16, sheetsPerSignature: 2, binding: 'left', flip: 'short',
    ...withStock({ processWasteRate: 0.1, sheetsPerPack: 250 }),
  });
  const sp = r.stockPreparation;
  assert.deepEqual(sp.signatures.map((d) => d.requiredSheets), [245, 245]);
  assert.equal(sp.totalRequired, 490);
  assert.notEqual(sp.totalRequired, merged);
  assert.equal(sp.totalNetSheets, 400);
  assert.equal(sp.totalMakereadyWaste, 40); // 开机损耗按帖计：20 × 2
  assert.equal(sp.totalProcessWaste, 50); // 490 - 400 - 40
  // 汇总后才按整包向上取整：ceil(490 / 250) = 2 包 = 500 张
  assert.equal(sp.packsToBuy, 2);
  assert.equal(sp.sheetsToBuy, 500);
  assert.equal(sp.spareSheets, 10);
});

test('整包恰好整除：余量为 0、包数正确', () => {
  const r = computeImposition({ ...BASE, ...withStock({ copies: 250, makereadyWaste: 0, processWasteRate: 0, sheetsPerPack: 250 }) });
  const sp = r.stockPreparation;
  assert.equal(sp.totalRequired, 500); // 2 张 × 250 份
  assert.equal(sp.packsToBuy, 2);
  assert.equal(sp.sheetsToBuy, 500);
  assert.equal(sp.spareSheets, 0);
});

test('均衡分帖：按各帖实际张数（非上限）计算净用纸', () => {
  // 17 页、上限 2 张：均衡分帖为 [2,2,1] 张（5 张 ÷ 3 帖，多出的靠前分配）
  const r = computeImposition({
    totalPages: 17, sheetsPerSignature: 2, binding: 'left', flip: 'short', balancedSplit: true,
    ...withStock({ copies: 1000, makereadyWaste: 0, processWasteRate: 0, sheetsPerPack: 250 }),
  });
  const sp = r.stockPreparation;
  assert.deepEqual(sp.signatures.map((d) => d.actualSheetCount), [2, 2, 1]);
  assert.deepEqual(sp.signatures.map((d) => d.netSheets), [2000, 2000, 1000]);
  assert.equal(sp.totalNetSheets, 5000);
  assert.equal(sp.totalRequired, 5000);
  assert.equal(sp.packsToBuy, 20);
  assert.equal(sp.sheetsToBuy, 5000);
});

test('章节优先分帖：按各帖实际张数逐帖计算（含末帖不足上限）', () => {
  // 20 页、上限 2 张、章节起始 [1, 9, 14, 18] => [2,2,2] 张（末帖含 1 页补白）
  const r = computeImposition({
    totalPages: 20, sheetsPerSignature: 2, binding: 'left', flip: 'short',
    chapterSplit: true, chapterStarts: [1, 9, 14, 18],
    ...withStock({ copies: 10, makereadyWaste: 0, processWasteRate: 0, sheetsPerPack: 100 }),
  });
  assert.deepEqual(r.chapters.actualSheetCounts, [2, 2, 2]);
  const sp = r.stockPreparation;
  // 补白页同样上机：净用纸按实际张数（含补白）计
  assert.deepEqual(sp.signatures.map((d) => d.netSheets), [20, 20, 20]);
  assert.equal(sp.totalRequired, 60);
  assert.equal(sp.packsToBuy, 1);
  assert.equal(sp.sheetsToBuy, 100);
  assert.equal(sp.spareSheets, 40);
});

test('试印核验重算（四种装订×翻转）与备料可同时启用', () => {
  const r = computeImposition({
    ...BASE, ...withStock(),
    observations: [
      { signature: 1, sheet: 1, side: 'front', position: 'right', page: 1, orientation: 'upright' },
    ],
  });
  assert.equal(r.verification.enabled, true);
  assert.equal(r.stockPreparation.enabled, true);
  assert.equal(r.stockPreparation.totalRequired, 232);
  // 重算的候选组合同样成功（输入回显备料参数，不触发参数缺失错误）
  assert.equal(r.verification.candidates.length, 4);
});

test('非法参数：份数 / 开机损耗 / 每包张数缺失或越界、损耗率 ≥1、开关非布尔均抛明确错误', () => {
  const cases = [
    [{}, /成品份数/],
    [{ copies: 0 }, /成品份数/],
    [{ copies: -3 }, /成品份数/],
    [{ copies: 1.5 }, /成品份数/],
    [{ copies: 'abc' }, /成品份数/],
    [{ copies: 100, makereadyWaste: -1 }, /开机损耗/],
    [{ copies: 100, makereadyWaste: 1.2 }, /开机损耗/],
    [{ copies: 100, makereadyWaste: 5, processWasteRate: 1, sheetsPerPack: 500 }, /过程损耗率/],
    [{ copies: 100, makereadyWaste: 5, processWasteRate: 1.5, sheetsPerPack: 500 }, /过程损耗率/],
    [{ copies: 100, makereadyWaste: 5, processWasteRate: -0.01, sheetsPerPack: 500 }, /过程损耗率/],
    [{ copies: 100, makereadyWaste: 5, processWasteRate: 'x', sheetsPerPack: 500 }, /过程损耗率/],
    [{ copies: 100, makereadyWaste: 5, processWasteRate: 0.03, sheetsPerPack: 0 }, /每包张数/],
    [{ copies: 100, makereadyWaste: 5, processWasteRate: 0.03, sheetsPerPack: 2.5 }, /每包张数/],
  ];
  for (const [patch, re] of cases) {
    assert.throws(
      () => computeImposition({ ...BASE, stockPreparation: true, ...patch }),
      re
    );
  }
  assert.throws(
    () => computeImposition({ ...BASE, stockPreparation: 'yes' }),
    /布尔值/
  );
});

test('数字字符串参数可接受（与其他模块解析口径一致）', () => {
  const r = computeImposition({
    ...BASE,
    stockPreparation: true,
    copies: '100',
    makereadyWaste: '20',
    processWasteRate: '0.05',
    sheetsPerPack: '500',
  });
  assert.equal(r.stockPreparation.totalRequired, 232);
  assert.equal(r.stockPreparation.packsToBuy, 1);
});

/* ------------------------------ HTTP 接口 ------------------------------ */

async function startServer() {
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function postJson(url, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

test('HTTP：未启用备料时响应与原流程一致', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, BASE);
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.stockPreparation, { enabled: false });
    assert.equal(res.body.signatures[0].stockPreparation, undefined);
  } finally {
    await srv.close();
  }
});

test('HTTP：导出的拼版清单 JSON 附带逐帖备料与整包采购汇总', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, { ...BASE, ...withStock() });
    assert.equal(res.status, 200);
    const sp = res.body.stockPreparation;
    assert.equal(sp.enabled, true);
    assert.equal(sp.copies, 100);
    assert.equal(sp.totalRequired, 232);
    assert.equal(sp.packsToBuy, 1);
    assert.equal(sp.sheetsToBuy, 500);
    // 逐帖数据同时挂在帖对象上（前端导出 / 展示同一份 JSON）
    assert.equal(res.body.signatures[0].stockPreparation.requiredSheets, 232);
    assert.equal(res.body.signatures[0].stockPreparation.netSheets, 200);
  } finally {
    await srv.close();
  }
});

test('HTTP：非法备料参数返回 400 明确错误', async () => {
  const srv = await startServer();
  try {
    const res = await postJson(`${srv.baseUrl}/api/impose`, {
      ...BASE, stockPreparation: true, copies: 100, makereadyWaste: 5,
      processWasteRate: 1, sheetsPerPack: 500,
    });
    assert.equal(res.status, 400);
    assert.match(res.body.error, /过程损耗率/);
  } finally {
    await srv.close();
  }
});
