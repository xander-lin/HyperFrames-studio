# Studio Shell — 上游 Studio 的 fork

本目录的上游代码来自 [heygen-com/hyperframes](https://github.com/heygen-com/hyperframes)
`packages/studio`，版本 **0.9.21**，许可 **Apache-2.0**（见 `LICENSE`）。

## 组成

```
src/               上游 Studio 源码，原样保留
src/annotate/      MyStudio 的全部新增代码（批注层）
src/annotate/mount.tsx   唯一的上游挂载点
```

## 改动纪律

1. 上游文件**保持原样**。需要改动的地方，一律：
   - 在行内加 `MYSTUDIO:` 注释说明原因；
   - 在 `PATCHES.md` 里登记一条，便于升级时重放。

2. 新代码只写在 `src/annotate/`。它通过 `mount.tsx` 挂到 `main.tsx` 的根节点旁边，
   不侵入上游组件树。

3. 上游的 700 个测试文件**完整保留**，未删除、未修改。它们在独立仓库里无法运行
   （依赖上游 monorepo 的 fixture 与 workspace 布局），因此 `vite.config.ts` 的
   `test.include` 只跑 `src/annotate/**`。它们是升级时的行为对照资产。

## 升级上游

```bash
# 1. 拉取目标版本的上游 packages/studio/src
# 2. 用本文件与 PATCHES.md 的清单重放 MYSTUDIO 改动
grep -rn "MYSTUDIO:" src/
```

不要用 git merge/分支合并——上游结构变动会让合并冲突淹没真正的改动。
