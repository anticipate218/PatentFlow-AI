/**
 * 打包进度的类型和文字说明（纯函数，不引用 docx）。
 * 进度卡片（progress-view.ts）随首屏加载；这些代码如果留在 export-package.ts，
 * 卡片一引用就会把 docx 和 Word 生成代码并进首屏脚本，导出相关的 import() 按需加载随之失效。
 */

/** 打包进度的阶段：核对格式 → 绘制附图 → 生成 Word → 压缩 → 保存 → 完成。 */
export type PackagePhase = "check" | "figures" | "documents" | "zip" | "save" | "done";

/**
 * 一次打包进度。所有计数都是真实完成数：每幅附图、每份 Word、压缩、保存各算一步，
 * 只在对应工作真正开始或完成时上报，不按耗时估算。
 */
export interface PackageProgress {
  phase: PackagePhase;
  /** 本阶段已完成的数量。 */
  done: number;
  /** 本阶段的总数。 */
  total: number;
  /** 正在处理的条目（如“说明书”“图2”）；没有时为空串。 */
  label: string;
  /** 整次打包已完成的步数。 */
  overallDone: number;
  /** 整次打包的总步数；一次打包中保持不变。 */
  overallTotal: number;
}

export function isAbortError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError";
}

/** 进度的中文说明：当前步骤和真实计数。 */
export function packageProgressText(progress: PackageProgress): string {
  const item = progress.label ? ` · ${progress.label}` : "";
  const current = Math.min(progress.done + 1, progress.total);
  switch (progress.phase) {
    case "check":
      return "正在核对申请文件格式";
    case "figures":
      return progress.done < progress.total ? `正在绘制附图 ${current} / ${progress.total}${item}` : `附图已全部绘制（${progress.total} 幅）`;
    case "documents":
      return progress.done < progress.total ? `正在生成 Word ${current} / ${progress.total}${item}` : `Word 已全部生成（${progress.total} 份）`;
    case "zip":
      return progress.done < progress.total ? "正在压缩打包" : "压缩完成";
    case "save":
      return "正在保存到下载文件夹";
    case "done":
      return "全套文件已生成";
  }
}
