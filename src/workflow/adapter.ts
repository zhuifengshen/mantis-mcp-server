import type { Session } from '../services/projects.js';
import { conservativeCapabilities, type AdapterCapabilities } from './query.js';

/** 按已核对的服务端版本适配；查询层仍校验原生结果并在不支持时降级。 */
export function capabilitiesFor(session: Session): AdapterCapabilities {
  // 2.26.2 的 filter_standard_get(assigned) 使用当前用户和项目的未解决筛选。
  // https://github.com/mantisbt/mantisbt/blob/release-2.26.2/core/filter_api.php
  return { ...conservativeCapabilities,
    nativeAssigned: session.mantisVersion === '2.26.2' };
}
