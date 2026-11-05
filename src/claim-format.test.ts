import test from "node:test";
import assert from "node:assert/strict";
import { formalCheck, parseApplication } from "./cnipa-format.ts";
import type { FormalCheck } from "./cnipa-format.ts";
import { claimRefNumbers, INVENTION_SYSTEM, parseClaims } from "./invention-draft.ts";
import { LIBRARY_SAMPLES } from "./patent-library.ts";

/** 本文件覆盖的五项权利要求书检查（《专利审查指南》第二部分第二章 3.3.2 节等）。 */
const IDS = ["claim-multiple", "claim-multiple-basis", "claim-order", "claim-reference", "claim-antecedent"];

function draft(claims: string[]): string {
  return [
    "# 发明名称：一种雨水井截污装置",
    "## 说明书摘要",
    "本发明公开了一种雨水井截污装置，包括井框和截污格栅，刮板由叶轮驱动沿格栅摆动，自动清除截留污物。",
    "## 权利要求书",
    ...claims,
    "## 技术领域",
    "本发明涉及市政排水设备技术领域。",
    "## 背景技术",
    "现有雨水井依赖人工清掏。",
    "## 发明内容",
    "解决截污格栅易堵塞的问题。",
    "## 具体实施方式",
    "井框(1)下方设置截污格栅(2)，刮板(3)由叶轮(4)驱动。",
  ].join("\n");
}

function claimChecks(claims: string[]): Map<string, FormalCheck> {
  const report = formalCheck(parseApplication(draft(claims)));
  return new Map(report.checks.filter((check) => IDS.includes(check.id)).map((check) => [check.id, check]));
}

function assertAllOk(checks: Map<string, FormalCheck>): void {
  for (const id of IDS) assert.equal(checks.get(id)?.level, "ok", `${id}: ${checks.get(id)?.detail}`);
}

const BASE = [
  "1. 一种雨水井截污装置，包括井框(1)，其特征在于，还包括截污格栅(2)和刮板(3)，所述刮板(3)由叶轮(4)驱动。",
  "2. 根据权利要求1所述的雨水井截污装置，其特征在于，所述截污格栅(2)呈弧形。",
];

test("权利要求引用编号展开“或”“、”列举和各种范围写法", () => {
  assert.deepEqual(claimRefNumbers("根据权利要求1或2所述的"), [1, 2]);
  assert.deepEqual(claimRefNumbers("根据权利要求1、3或5至7中任一项所述的"), [1, 3, 5, 6, 7]);
  assert.deepEqual(claimRefNumbers("根据权利要求1～3中任一项所述的"), [1, 2, 3]);
  assert.deepEqual(claimRefNumbers("根据权利要求1和权利要求2所述的"), [1, 2]);
  assert.deepEqual(claimRefNumbers("根据权利要求10-12任一项所述的"), [10, 11, 12]);
  assert.deepEqual(claimRefNumbers("根据权利要求1至权利要求3中任一项所述的"), [1, 2, 3]);
  assert.deepEqual(parseClaims("1. 一种装置。\n2. 根据权利要求1所述的装置。\n3. 根据权利要求1或2所述的装置。")[2].refs, [1, 2]);
});

test("“根据权利要求1或4所述”中在后的 4 也计入引用，在后引用能被发现", () => {
  const report = formalCheck(parseApplication(draft([
    ...BASE,
    "3. 根据权利要求1或4所述的雨水井截污装置，其特征在于，所述井框(1)为铸铁井框。",
    "4. 根据权利要求1所述的雨水井截污装置，其特征在于，所述刮板(3)为橡胶刮板。",
  ])));
  assert.equal(report.checks.find((check) => check.id === "claim-refs")?.level, "error");
});

test("规范的权利要求书通过五项检查：择一引用、引用其他权利要求的独立权利要求、主题名称简称", () => {
  assertAllOk(claimChecks([
    ...BASE,
    "3. 根据权利要求1或2所述的截污装置，其特征在于，所述刮板(3)为橡胶刮板。",
    "4. 根据权利要求1或2所述的装置，其特征在于，所述叶轮(4)设置在所述截污格栅(2)的下游。",
    "5. 一种雨水井，其特征在于，包括井体和权利要求1至4中任一项所述的雨水井截污装置，所述井框(1)固定于所述井体。",
    "6. 根据权利要求5所述的雨水井，其特征在于，所述井体的底部设有沉泥槽。",
  ]));
});

test("多项从属权利要求不得并列引用，也不得引用另一项多项从属权利要求", () => {
  const checks = claimChecks([
    ...BASE,
    "3. 根据权利要求1和2所述的雨水井截污装置，其特征在于，所述刮板(3)为橡胶刮板。",
    "4. 根据权利要求2或3所述的雨水井截污装置，其特征在于，所述叶轮(4)为轴流叶轮。",
  ]);
  assert.equal(checks.get("claim-multiple")?.level, "error");
  assert.match(checks.get("claim-multiple")?.detail ?? "", /第 3 条用“和”“及”等并列引用/);
  assert.equal(checks.get("claim-multiple-basis")?.level, "error");
  assert.match(checks.get("claim-multiple-basis")?.detail ?? "", /第 4 条引用了同为多项从属权利要求的第 3 条/);
});

test("引用两项以上权利要求却没有写明“或”“任一项”时提示改为择一引用", () => {
  const checks = claimChecks([...BASE, "3. 根据权利要求1至2所述的雨水井截污装置，其特征在于，所述刮板(3)为橡胶刮板。"]);
  assert.equal(checks.get("claim-multiple")?.level, "warn");
  assert.match(checks.get("claim-multiple")?.detail ?? "", /第 3 条引用两项以上权利要求但没有写明择一关系/);
});

test("从属权利要求写在另一项独立权利要求之后时提示调整位置", () => {
  const checks = claimChecks([
    ...BASE,
    "3. 一种雨水井清淤方法，其特征在于，包括：S1、提起井框(1)；S2、清理截污格栅(2)。",
    "4. 根据权利要求1所述的雨水井截污装置，其特征在于，所述刮板(3)为橡胶刮板。",
  ]);
  assert.equal(checks.get("claim-order")?.level, "warn");
  assert.match(checks.get("claim-order")?.detail ?? "", /第 4 条从属于第 1 条，却写在另一项独立权利要求第 3 条之后/);
});

test("主题名称中的“应用于”和正文中的“……的应用”不会把产品权利要求当成用途权利要求", () => {
  const appliedTo = claimChecks([
    "1. 一种应用于雨水井的截污装置，包括井框(1)和刮板(3)。",
    "2. 根据权利要求1所述的截污装置，其特征在于，所述刮板(3)为橡胶刮板。",
    "3. 一种清淤方法，其特征在于，包括清理井框。",
    "4. 根据权利要求1和2所述的截污装置，其特征在于，所述井框(1)为铸铁井框。",
  ]);
  assert.equal(appliedTo.get("claim-multiple")?.level, "error");
  assert.equal(appliedTo.get("claim-order")?.level, "warn");
  const appInBody = claimChecks([
    "1. 一种移动终端，包括处理器，所述处理器运行目标的应用，以及存储器。",
    "2. 根据权利要求1所述的移动终端，其特征在于，所述存储器为闪存。",
    "3. 一种显示方法，其特征在于，包括显示图像。",
    "4. 根据权利要求1所述的移动终端，其特征在于，所述处理器为多核处理器。",
  ]);
  assert.equal(appInBody.get("claim-order")?.level, "warn");
});

test("引用部分须写明编号和主题名称", () => {
  const checks = claimChecks([
    ...BASE,
    "3. 根据权利要求1，其特征在于，所述刮板(3)为橡胶刮板。",
    "4. 根据前面任一项权利要求所述的截污装置，其特征在于，所述叶轮(4)为轴流叶轮。",
  ]);
  const detail = checks.get("claim-reference")?.detail ?? "";
  assert.equal(checks.get("claim-reference")?.level, "warn");
  assert.match(detail, /第 3 条的引用部分没有写主题名称/);
  assert.match(detail, /第 4 条用“前述权利要求”一类写法，没有写明所引用权利要求的编号/);
  assert.equal(checks.get("claim-multiple")?.level, "ok", "“前面任一项权利要求”是择一引用");
});

test("从属权利要求的主题名称允许简称，不允许换成另一主题", () => {
  assert.equal(claimChecks([...BASE, "3. 根据权利要求2所述的装置，其特征在于，所述刮板(3)为橡胶刮板。"]).get("claim-reference")?.level, "ok");
  const renamed = claimChecks([
    ...BASE,
    "3. 根据权利要求1所述的截污系统，其特征在于，所述刮板(3)为橡胶刮板。",
    "4. 根据权利要求1所述的方法，其特征在于，所述叶轮(4)为轴流叶轮。",
  ]);
  assert.equal(renamed.get("claim-reference")?.level, "warn");
  assert.match(renamed.get("claim-reference")?.detail ?? "", /第 3 条写作“截污系统”/);
  assert.match(renamed.get("claim-reference")?.detail ?? "", /第 4 条写作“方法”/);
});

test("引用在前权利要求的制备方法、用途和正文中引用其他权利要求的权利要求，按独立权利要求处理", () => {
  assertAllOk(claimChecks([
    "1. 一种防腐涂料，其特征在于，包括环氧树脂和固化剂。",
    "2. 根据权利要求1所述的防腐涂料，其特征在于，所述固化剂为聚酰胺。",
    "3. 一种储罐，其特征在于，包括罐体，所述罐体的内壁涂覆有权利要求1或2所述的防腐涂料。",
    "4. 根据权利要求1或2所述的防腐涂料的制备方法，其特征在于，包括：将所述环氧树脂与所述固化剂混合。",
    "5. 根据权利要求4所述的制备方法，其特征在于，混合温度为20℃至30℃。",
    "6. 根据权利要求1或2所述的防腐涂料在船舶防腐中的应用。",
    "7. 涂装设备，包括处理器和存储器，所述存储器存储有程序，所述程序被所述处理器执行时控制权利要求4或5所述的制备方法。",
    "8. 权利要求1或2所述的防腐涂料在制备用于防护船舶的涂层，或用于防护跨海桥梁的涂层中的用途。",
    "9. 根据权利要求8所述的用途，其中所述涂层的厚度为100μm至300μm。",
  ]));
});

test("“所述××”没有在先表述时提示；引用基础可以在本项前文或所引用的权利要求中", () => {
  const missing = claimChecks([...BASE, "3. 根据权利要求2所述的雨水井截污装置，其特征在于，所述电机通过皮带带动所述叶轮(4)。"]);
  assert.equal(missing.get("claim-antecedent")?.level, "warn");
  assert.match(missing.get("claim-antecedent")?.detail ?? "", /第 3 条“所述电机/);
  const introduced = claimChecks([...BASE, "3. 根据权利要求2所述的雨水井截污装置，其特征在于，还包括电机，所述电机通过皮带带动所述叶轮(4)。"]);
  assert.equal(introduced.get("claim-antecedent")?.level, "ok");
  // 引用部分之后同一分句里的“所述”仍要检查
  const sameClause = claimChecks([...BASE, "3. 根据权利要求1所述的雨水井截污装置包括所述电机。"]);
  assert.match(sameClause.get("claim-antecedent")?.detail ?? "", /第 3 条“所述电机”/);
});

test("步骤编号、同一附图标记的不同称呼、限定词和“前述权利要求”不误报引用基础", () => {
  const checks = claimChecks([
    "1. 一种雨水井截污方法，其特征在于，包括：S1、采集多个水位传感器(5)的读数；S2、根据所述读数驱动刮板(3)。",
    "2. 根据权利要求1所述的方法，其特征在于，所述S1中，所述各水位传感器(5)每分钟采集一次。",
    "3. 根据权利要求1所述的方法，其特征在于，所述步骤S2中，所述超声波水位传感器(5)安装在井壁上。",
    "4. 根据前述权利要求中任一项所述的方法，其特征在于，所述刮板(3)为橡胶刮板。",
  ]);
  assert.equal(checks.get("claim-antecedent")?.level, "ok", checks.get("claim-antecedent")?.detail);
  // “前述权利要求”没有写编号，只在引用部分一项提示
  assert.match(checks.get("claim-reference")?.detail ?? "", /^第 4 条用“前述权利要求”一类写法/);
  for (const id of IDS.filter((item) => item !== "claim-reference")) assert.equal(checks.get(id)?.level, "ok", `${id}: ${checks.get(id)?.detail}`);
});

test("权利要求编号不连续时只提示修正编号，不做引用关系检查", () => {
  const report = formalCheck(parseApplication(draft([...BASE, "4. 根据权利要求1和2所述的装置，其特征在于，所述电机为步进电机。"])));
  assert.equal(report.checks.find((check) => check.id === "claim-numbering")?.level, "error");
  assert.deepEqual(report.checks.filter((check) => IDS.includes(check.id)), []);
});

test("知识库内置的虚构示范样例通过五项检查", () => {
  for (const sample of LIBRARY_SAMPLES) {
    const report = formalCheck(parseApplication(sample.markdown, sample.title));
    for (const id of IDS) {
      const check = report.checks.find((item) => item.id === id);
      assert.equal(check?.level, "ok", `${sample.id} ${id}: ${check?.detail}`);
    }
  }
});

test("撰写提示词写明多项从属择一引用、主题名称和引用基础的要求", () => {
  assert.match(INVENTION_SYSTEM, /只能择一引用/);
  assert.match(INVENTION_SYSTEM, /不得被另一项多项从属权利要求引用/);
  assert.match(INVENTION_SYSTEM, /重述其主题名称/);
  assert.match(INVENTION_SYSTEM, /缺乏引用基础/);
});
