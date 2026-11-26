/* 清空开发数据库与上传文件，然后退出。谨慎：仅用于本地开发。 */
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dataDir = process.env.HIRELOOP_DATA_DIR
  ? path.resolve(process.env.HIRELOOP_DATA_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data');

if (!existsSync(dataDir)) {
  console.log('没有可清理的数据目录:', dataDir);
  process.exit(0);
}
const resolved = path.resolve(dataDir);
if (path.basename(resolved) !== 'data' || !resolved.includes('招聘平台pro')) {
  console.error('拒绝删除非预期目录:', resolved);
  process.exit(1);
}
rmSync(resolved, { recursive: true, force: true });
console.log('已清空:', resolved);
