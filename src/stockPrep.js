'use strict';

/**
 * 印刷备料（print stock preparation）。
 *
 * 在拼版结果（逐帖实际张数）之上计算用纸领用 / 采购数量。
 * 计算顺序（关键：必须逐帖独立取整，禁止先合并各帖再计算损耗）：
 *
 * 1. 净用纸：每帖按该帖实际张数 × 成品份数（含自动补白页位，补白页同样要上机印刷）：
 *      netSheets = actualSheetCount × copies
 * 2. 逐帖需领纸：开机损耗按帖计（每帖一次调机过版纸），过程损耗率作用于净用纸与开机损耗之和，
 *    并在帖内向上取整：
 *      requiredSheets = ceil((netSheets + makereadyWaste) / (1 - processWasteRate))
 * 3. 汇总：总净用纸 / 总开机损耗 / 总需领纸 = Σ 各帖；
 *    仅在逐帖取整完成后才允许相加，不得先把各帖净用纸与开机损耗合并再整体套公式
 *    （逐帖 ceil 会让需领纸多于合并口径，这是领料必须覆盖的数量）。
 * 4. 整包采购：全部需领纸汇总后再按每包张数向上取整：
 *      packsToBuy = ceil(totalRequired / sheetsPerPack)
 *      sheetsToBuy = packsToBuy × sheetsPerPack
 *
 * 未启用（stockPreparation 缺省 / false）时不向结果写入任何字段，原响应完全不变。
 */

/**
 * 解析正整数参数：接受整数或纯数字字符串（与试印核验的索引解析口径一致），
 * 布尔 / null / 空串 / 小数 / NaN 均视为非法（返回 NaN，由调用方报错）。
 */
function toPositiveInteger(value) {
  const n = typeof value === 'number' ? value
    : (typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN);
  return Number.isInteger(n) ? n : NaN;
}

/**
 * 解析过程损耗率：接受 [0, 1) 的数字或纯数字字符串（如 0.03 或 "3" 不做百分号换算，
 * 由前端把百分数换算成小数后上送）。1（100%）及以上无意义（领料发散），明确报错。
 */
function parseProcessWasteRate(value) {
  if (value === undefined || value === null) return 0;
  if (typeof value === 'boolean') return NaN;
  if (typeof value === 'string' && value.trim() === '') return NaN;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || n >= 1) return NaN;
  return n;
}

/**
 * 解析备料输入。
 * @returns {{enabled:false} | {enabled:true, copies:number, makereadyWaste:number, processWasteRate:number, sheetsPerPack:number}}
 */
function parseStockPrepInput(input) {
  const enabled = !!(input && input.stockPreparation === true);
  if (input && input.stockPreparation !== undefined && typeof input.stockPreparation !== 'boolean') {
    throw new Error('印刷备料开关必须为布尔值（true / false）');
  }
  if (!enabled) return { enabled: false };

  const copies = toPositiveInteger(input && input.copies);
  if (!Number.isInteger(copies) || copies < 1) {
    throw new Error('启用印刷备料时，成品份数 copies 必须为 ≥ 1 的整数');
  }
  const makereadyWaste = toPositiveInteger(input && input.makereadyWaste);
  if (!Number.isInteger(makereadyWaste) || makereadyWaste < 0) {
    throw new Error('启用印刷备料时，每帖开机损耗张数 makereadyWaste 必须为 ≥ 0 的整数');
  }
  const processWasteRate = parseProcessWasteRate(input && input.processWasteRate);
  if (Number.isNaN(processWasteRate)) {
    throw new Error('启用印刷备料时，过程损耗率 processWasteRate 必须为 ≥ 0 且 < 1 的数字（如 0.03 表示 3%）');
  }
  const sheetsPerPack = toPositiveInteger(input && input.sheetsPerPack);
  if (!Number.isInteger(sheetsPerPack) || sheetsPerPack < 1) {
    throw new Error('启用印刷备料时，每包张数 sheetsPerPack 必须为 ≥ 1 的整数');
  }

  return { enabled: true, copies, makereadyWaste, processWasteRate, sheetsPerPack };
}

/**
 * 对 x 向上取整并吸收浮点尾数：恰好为整数（浮点误差 ±1e-9 内）时取整数值本身，
 * 避免 (净用纸 + 开机损耗) / (1 - 损耗率) 在数学上恰为整数时被多 ceil 一张。
 */
function ceilLoose(x) {
  const r = Math.round(x);
  if (Math.abs(x - r) < 1e-9) return r;
  return Math.ceil(x);
}

/**
 * 计算单帖备料明细（纯函数，便于单测）。
 * @returns {{index:number, actualSheetCount:number, netSheets:number, makereadyWaste:number,
 *            processWasteRate:number, requiredSheets:number,
 *            wasteSheets:number, makereadyWasteSheets:number, processWasteSheets:number}}
 */
function computeSignatureStock(sigIndex, actualSheetCount, opts) {
  const { copies, makereadyWaste, processWasteRate } = opts;
  const netSheets = actualSheetCount * copies;
  const requiredSheets = ceilLoose((netSheets + makereadyWaste) / (1 - processWasteRate));
  const wasteSheets = requiredSheets - netSheets;
  const processWasteSheets = requiredSheets - netSheets - makereadyWaste;
  return {
    index: sigIndex,
    actualSheetCount,
    netSheets,
    makereadyWaste,
    processWasteRate,
    requiredSheets,
    wasteSheets,
    // 开机损耗按帖固定计入；过程损耗 = 需领纸 − 净用纸 − 开机损耗（含逐帖取整多领的张数）
    makereadyWasteSheets: makereadyWaste,
    processWasteSheets,
  };
}

/**
 * 依据拼版结果逐帖计算备料，写入每帖 sig.stockPreparation 并返回顶层汇总。
 * 逐帖 ceil 完成后才允许汇总；整包采购在全部汇总之后再做一次向上取整。
 */
function attachStockPreparation(result, opts) {
  if (!opts.enabled) {
    return { enabled: false };
  }
  const perSignature = result.signatures.map((sig) => {
    const detail = computeSignatureStock(sig.index, sig.actualSheetCount, opts);
    sig.stockPreparation = detail;
    return detail;
  });

  const totalNetSheets = perSignature.reduce((sum, d) => sum + d.netSheets, 0);
  const totalMakereadyWaste = perSignature.reduce((sum, d) => sum + d.makereadyWasteSheets, 0);
  const totalProcessWaste = perSignature.reduce((sum, d) => sum + d.processWasteSheets, 0);
  const totalRequired = perSignature.reduce((sum, d) => sum + d.requiredSheets, 0);
  const totalWaste = totalRequired - totalNetSheets;

  const packsToBuy = Math.ceil(totalRequired / opts.sheetsPerPack);
  const sheetsToBuy = packsToBuy * opts.sheetsPerPack;
  const spareSheets = sheetsToBuy - totalRequired;

  return {
    enabled: true,
    copies: opts.copies,
    makereadyWaste: opts.makereadyWaste,
    processWasteRate: opts.processWasteRate,
    sheetsPerPack: opts.sheetsPerPack,
    rule: 'requiredSheets = ceil((netSheets + makereadyWaste) / (1 - processWasteRate))，逐帖独立取整后汇总，禁止先合并各帖再计算损耗',
    totalNetSheets,
    totalMakereadyWaste,
    totalProcessWaste,
    totalWaste,
    totalRequired,
    packsToBuy,
    sheetsToBuy,
    spareSheets,
    signatures: perSignature,
  };
}

module.exports = {
  parseStockPrepInput,
  attachStockPreparation,
  computeSignatureStock,
};
