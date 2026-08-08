# 2026-08-08 迁移基线压平（squash）

## 背景

系统未上线，全部数据库均为可重建的开发/测试库。迁移目录积累到 24 个文件后
出现结构性问题：

- 修正链：00010→00011→00012 三个文件净效果只是建一张 `bas_party_address`。
- 双份事实源：00022 混合 DDL 与编号规则种子，`db:reset` 无法重放，被迫复制出
  00024 纯种子副本。
- 死迁移：00007/00008/00017 及 00021/00022 的回填段只对「已运行的旧库」有意义，
  全新库执行为空操作。
- goose 注解是遗迹：`server-go` 已删除（见 tag `server-go-final`），本执行器只跑
  Up 段，Down 段无人消费。

## 决定

1. **压平为 4 个文件**：
   - `00001_baseline.sql`：scratch 库重放历史 00001–00024 后
     `pg_dump --schema-only --no-owner` 重新导出（与旧 baseline 同一产出方式），
     排除运行时自建的 `synie_schema_migration`。
   - `00002_seed_settings_singletons.sql` / `00003_seed_market_catalog.sql` /
     `00004_seed_numbering_rules.sql`：纯种子（幂等 INSERT、无 DDL），
     `db:reset` 重放这三个文件。
2. **放弃历史升级路径**：所有库 drop 重建（migrate + setup 向导）。
   数据回填/清洗类迁移随之删除。
3. **迁移文件改纯 SQL**：去掉 `-- +goose Up/Down` 注解，执行器不再解析注解、
   不支持回滚。
4. **删除 better-auth 存量用户回填桥**（sys_user → auth_user/auth_account）：
   重建后不存在「只有 sys_user」的旧形态用户。请求级双通道（cookie 优先、
   Bearer 回退）保留——它是存量单测基座的默认通道，退役另行决策。

## 约定（今后）

- 迁移文件只放 DDL；种子单独成 `_seed_` 文件且必须幂等，DDL 与种子不得同文件。
- 未上线期间需要修正历史数据时重建库，不写回填迁移。
- 上线前最后一次压平作为 v1 基线，此后迁移只增不改。

## 影响

- `synie_schema_migration` 按文件名追踪，压平后旧库必须重建。
- `reset.ts` 的 `RESEED_MIGRATIONS` 与 setup 集成测试的重放名单同步更新。
- `migrate.ts` 的追踪表引用全部限定 `public.`：baseline 若重置 search_path，
  不受会话级污染。
