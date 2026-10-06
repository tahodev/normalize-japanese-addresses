import { number2kanji } from '@geolonia/japanese-numeral'
import { currentConfig } from './config'
import { kan2num } from './lib/kan2num'
import { zen2han } from './lib/zen2han'
import { patchAddr } from './lib/patchAddr'
import {
  getPrefectures,
  getPrefectureRegexPatterns,
  getCityRegexPatterns,
  getTownRegexPatterns,
  getSameNamedPrefectureCityRegexPatterns,
  getRsdt,
  getChiban,
} from './lib/cacheRegexes'
import {
  chibanToString,
  cityName,
  machiAzaName,
  prefectureName,
  rsdtToString,
  SingleChiban,
  SingleCity,
  SingleMachiAza,
  SinglePrefecture,
  SingleRsdt,
} from '@geolonia/japanese-addresses-v2'
import { prenormalize } from './lib/normalizeHelpers'
import {
  cityToResultPoint,
  machiAzaToResultPoint,
  NormalizeResult,
  NormalizeResultPoint,
  ParentOfChildrenEvidence,
  prefectureToResultPoint,
  rsdtOrChibanToResultPoint,
  upgradePoint,
} from './types'
import {
  distanceMeters,
  removeCitiesFromPrefecture,
  removeExtraFromMachiAza,
} from './lib/utils'

export type TransformRequestQuery = {
  level: number //  level = -1 は旧 API。 transformRequestFunction を設定しても無視する
  pref?: string
  city?: string
  town?: string
}

const __VERSION__: string = 'dev'
export const version = __VERSION__

/**
 * normalize {@link Normalizer} の動作オプション。
 */
export interface Config {
  /** 住所データを URL 形式で指定。 file:// 形式で指定するとローカルファイルを参照できます。 */
  japaneseAddressesApi: string

  /** 内部キャッシュの最大サイズ。デフォルトでは 1,000 件 */
  cacheSize: number

  geoloniaApiKey?: string
}
export const config: Config = currentConfig

/**
 * 正規化関数の {@link normalize} のオプション
 */
export interface Option {
  /**
   * 希望最大正規化を行うレベルを指定します。{@link Option.level}
   *
   * @see https://github.com/geolonia/normalize-japanese-addresses#normalizeaddress-string
   */
  level?: number

  geoloniaApiKey?: string

  /**
   * 地番データに親番号が無く子番号だけがあるとき、親番号を確定扱いにするか。既定は `false`。
   *
   * 分筆で親番号の地番が消えた町字では、`323` が無く `323-1`, `323-2` … だけが
   * データにあることがある。`true` のとき、入力が親番号だけならその町字を
   * `level: 8`・`addrSource: 'parent-of-children'` で返し、`point` は子番号の座標の重心にする。
   * 子番号の座標が 1 km 以上散らばるときは、親番号が別の地点を指している可能性が高いので採用しない。
   * 地番の町字のみが対象で、住居表示の町字では何もしない。
   */
  allowParentOfChildren?: boolean
}

/**
 * 住所を正規化します。
 *
 * @param input - 住所文字列
 * @param option -  正規化のオプション {@link Option}
 *
 * @returns 正規化結果のオブジェクト {@link NormalizeResult}
 *
 * @see https://github.com/geolonia/normalize-japanese-addresses#normalizeaddress-string
 */
export type Normalizer = (
  input: string,
  option?: Option,
) => Promise<NormalizeResult>

const defaultOption = {
  level: 8,
}

const normalizeTownName = async (
  input: string,
  pref: SinglePrefecture,
  city: SingleCity,
  apiVersion: number,
) => {
  input = input.trim().replace(/^大字/, '')
  const townPatterns = await getTownRegexPatterns(pref, city, apiVersion)

  const regexPrefixes = ['^']
  if (city.city === '京都市') {
    // 京都は通り名削除のために後方一致を使う
    regexPrefixes.push('.*')
  }

  for (const regexPrefix of regexPrefixes) {
    for (const [town, pattern] of townPatterns) {
      const regex = new RegExp(`${regexPrefix}${pattern}`)
      const match = input.match(regex)
      if (match) {
        return {
          town,
          other: input.substring(match[0].length),
        }
      }
    }
  }
}

/** 子番号の座標がこの距離（メートル）以上散らばる親番号は採用しない */
const PARENT_MAX_SPREAD_METERS = 1_000

type ParentOfChildren = {
  addr: string
  point?: NormalizeResultPoint
  evidence: ParentOfChildrenEvidence
}

/**
 * 親番号が子番号群の接頭辞として存在するかを調べる。
 *
 * @param chibanList - 町字の地番データ
 * @param parent - 入力の番地（例 `323`）
 * @returns 子番号（`323-1` など）があり、座標の散らばりが許容範囲なら親番号の情報。無ければ `undefined`
 */
function findParentOfChildren(
  chibanList: SingleChiban[],
  parent: string,
): ParentOfChildren | undefined {
  const prefix = `${parent}-`
  const children = chibanList.filter((chiban) =>
    chibanToString(chiban).startsWith(prefix),
  )
  if (children.length === 0) {
    return undefined
  }

  // 座標を持つ子番号の重心と、重心からの最大距離を求める
  const points = children.flatMap((chiban) =>
    chiban.point ? [chiban.point] : [],
  )
  if (points.length === 0) {
    return {
      addr: parent,
      evidence: { count: children.length, spreadMeters: null },
    }
  }
  const centroid: [number, number] = [
    points.reduce((sum, p) => sum + p[0], 0) / points.length,
    points.reduce((sum, p) => sum + p[1], 0) / points.length,
  ]
  const spreadMeters = Math.max(
    ...points.map((p) => distanceMeters(centroid, p)),
  )
  if (spreadMeters >= PARENT_MAX_SPREAD_METERS) {
    return undefined
  }
  return {
    addr: parent,
    point: { lng: centroid[0], lat: centroid[1], level: 8 },
    evidence: { count: children.length, spreadMeters },
  }
}

type NormalizedAddrPart = {
  chiban?: SingleChiban
  rsdt?: SingleRsdt
  parent?: ParentOfChildren
  rest: string
}
async function normalizeAddrPart(
  addr: string,
  pref: SinglePrefecture,
  city: SingleCity,
  town: SingleMachiAza,
  apiVersion: number,
  allowParentOfChildren: boolean,
): Promise<NormalizedAddrPart> {
  // 先頭の項だけ 0 始まり（`02番16号` → `02-16`）を許す。値が 0 の項（`0`, `00`）は番地として読まない。
  // 2 項目以降は従来どおり 0 始まりを許さない（`1-031` の `-031` は部屋番号などで、番地に含めない）
  const match = addr.match(
    /^(0*[1-9][0-9]*)(?:-([1-9][0-9]*))?(?:-([1-9][0-9]*))?/,
  )
  if (!match) {
    return {
      rest: addr,
    }
  }
  // データ側の表記（先頭の 0 なし）に合わせて照合用の文字列を作る
  const matched = match[0]
  const key = match
    .slice(1)
    .filter((part) => typeof part !== 'undefined')
    .map((part) => part.replace(/^0+/, ''))
    .join('-')
  // TODO: rsdtの場合はrsdtと地番を両方取得する
  if (town.rsdt) {
    const res = await getRsdt(pref, city, town, apiVersion)
    for (const rsdt of res) {
      const addrPart = rsdtToString(rsdt)
      if (key === addrPart) {
        return {
          rsdt,
          rest: addr.substring(matched.length),
        }
      }
    }
  } else {
    const res = await getChiban(pref, city, town, apiVersion)
    for (const chiban of res) {
      const addrPart = chibanToString(chiban)
      if (key === addrPart) {
        return {
          chiban,
          rest: addr.substring(matched.length),
        }
      }
    }
    // 完全一致が無いとき、親番号が子番号群の接頭辞として存在すれば親番号を確定扱いにする
    if (allowParentOfChildren) {
      const parent = findParentOfChildren(res, match[0])
      if (parent) {
        return {
          parent,
          rest: addr.substring(match[0].length),
        }
      }
    }
  }
  return {
    rest: addr,
  }
}

export const normalize: Normalizer = async (
  address,
  _option = defaultOption,
) => {
  const option = { ...defaultOption, ..._option }

  option.geoloniaApiKey ??= config.geoloniaApiKey

  // other に入っている文字列は正規化するときに
  let other = prenormalize(address)

  let pref: SinglePrefecture | undefined
  let city: SingleCity | undefined
  let town: SingleMachiAza | undefined
  let point: NormalizeResultPoint | undefined
  let addr: string | undefined
  let addrSource: NormalizeResult['addrSource']
  let level = 0

  // 都道府県名の正規化

  const prefectures = await getPrefectures()
  const apiVersion = prefectures.meta.updated
  const prefPatterns = getPrefectureRegexPatterns(prefectures)
  const sameNamedPrefectureCityRegexPatterns =
    getSameNamedPrefectureCityRegexPatterns(prefectures)

  // 県名が省略されており、かつ市の名前がどこかの都道府県名と同じ場合(例.千葉県千葉市)、
  // あらかじめ県名を補完しておく。
  for (const [prefectureCity, reg] of sameNamedPrefectureCityRegexPatterns) {
    const match = other.match(reg)
    if (match) {
      other = other.replace(new RegExp(reg), prefectureCity)
      break
    }
  }

  for (const [_pref, pattern] of prefPatterns) {
    const match = other.match(pattern)
    if (match) {
      pref = _pref
      other = other.substring(match[0].length) // 都道府県名以降の住所
      point = prefectureToResultPoint(pref)
      break
    }
  }

  if (!pref) {
    // 都道府県名が省略されている
    const matched: {
      pref: SinglePrefecture
      city: SingleCity
      other: string
    }[] = []
    for (const _pref of prefectures.data) {
      const cityPatterns = getCityRegexPatterns(_pref)

      other = other.trim()
      for (const [_city, pattern] of cityPatterns) {
        const match = other.match(pattern)
        if (match) {
          matched.push({
            pref: _pref,
            city: _city,
            other: other.substring(match[0].length),
          })
        }
      }
    }

    // マッチする都道府県が複数ある場合は町名まで正規化して都道府県名を判別する。（例: 東京都府中市と広島県府中市など）
    if (1 === matched.length) {
      pref = matched[0].pref
    } else {
      for (const m of matched) {
        const normalized = await normalizeTownName(
          m.other,
          m.pref,
          m.city,
          apiVersion,
        )
        if (normalized) {
          pref = m.pref
          city = m.city
          town = normalized.town
          other = normalized.other
          point = upgradePoint(point, machiAzaToResultPoint(town))
        }
      }
    }
  }

  if (pref && option.level >= 2) {
    const cityPatterns = getCityRegexPatterns(pref)

    other = other.trim()
    for (const [_city, pattern] of cityPatterns) {
      const match = other.match(pattern)
      if (match) {
        city = _city
        point = upgradePoint(point, cityToResultPoint(city))
        other = other.substring(match[0].length) // 市区町村名以降の住所
        break
      }
    }
  }

  // 町丁目以降の正規化
  if (pref && city && option.level >= 3) {
    const normalized = await normalizeTownName(other, pref, city, apiVersion)
    if (normalized) {
      town = normalized.town
      other = normalized.other
      point = upgradePoint(point, machiAzaToResultPoint(town))
    }

    // townが取得できた場合にのみ、addrに対する各種の変換処理を行う。
    if (town) {
      other = other
        .replace(/^-/, '')
        .replace(/([0-9]+)(丁目)/g, (match) => {
          return match.replace(/([0-9]+)/g, (num) => {
            return number2kanji(Number(num))
          })
        })
        .replace(
          /(([0-9]+|[〇一二三四五六七八九十百千]+)(番地?)([0-9]+|[〇一二三四五六七八九十百千]+)号)\s*(.+)/,
          '$1 $5',
        )
        .replace(
          /([0-9]+|[〇一二三四五六七八九十百千]+)\s*(番地?)\s*([0-9]+|[〇一二三四五六七八九十百千]+)\s*号?/,
          '$1-$3',
        )
        .replace(/([0-9]+|[〇一二三四五六七八九十百千]+)番(地|$)/, '$1')
        .replace(
          /([0-9]+|[〇一二三四五六七八九十百千]+)の(?=[0-9０-９〇一二三四五六七八九十百千])/g,
          '$1-',
        )
        .replace(
          /([0-9]+|[〇一二三四五六七八九十百千]+)[-－﹣−‐⁃‑‒–—﹘―⎯⏤ーｰ─━]/g,
          (match) => {
            return kan2num(match).replace(/[-－﹣−‐⁃‑‒–—﹘―⎯⏤ーｰ─━]/g, '-')
          },
        )
        .replace(
          /[-－﹣−‐⁃‑‒–—﹘―⎯⏤ーｰ─━]([0-9]+|[〇一二三四五六七八九十百千]+)/g,
          (match) => {
            return kan2num(match).replace(/[-－﹣−‐⁃‑‒–—﹘―⎯⏤ーｰ─━]/g, '-')
          },
        )
        .replace(/([0-9]+|[〇一二三四五六七八九十百千]+)-/, (s) => {
          // `1-` のようなケース
          return kan2num(s)
        })
        .replace(/-([0-9]+|[〇一二三四五六七八九十百千]+)/, (s) => {
          // `-1` のようなケース
          return kan2num(s)
        })
        .replace(/-[^0-9]([0-9]+)/, (s) => {
          // `-あ1` のようなケース
          return kan2num(zen2han(s))
        })
        .replace(
          /-[^0-9\p{Script=Hiragana}\p{Script=Katakana}]([〇一二三四五六七八九十百千]+)/u,
          (s) => {
            // `-Ａ二二` のようなケース（かなを挟む `-ル千` のような建物名は変換しない）
            return kan2num(zen2han(s))
          },
        )
        .replace(/([0-9]+|[〇一二三四五六七八九十百千]+)$/, (s) => {
          // `串本町串本１２３４` のようなケース
          return kan2num(s)
        })
        .trim()
    }
  }

  other = patchAddr(
    pref ? prefectureName(pref) : '',
    city ? cityName(city) : '',
    town ? machiAzaName(town) : '',
    other,
  )

  if (pref) level = level + 1
  if (city) level = level + 1
  if (town) level = level + 1

  if (option.level <= 3 || level < 3) {
    const result: NormalizeResult = {
      pref: pref ? prefectureName(pref) : undefined,
      city: city ? cityName(city) : undefined,
      town: town ? machiAzaName(town) : undefined,
      other: other,
      level,
      point,
      metadata: {
        input: address,
        prefecture: removeCitiesFromPrefecture(pref),
        city: city,
        machiAza: removeExtraFromMachiAza(town),
      },
    }
    return result
  }

  const normalizedAddrPart = await normalizeAddrPart(
    other,
    pref!,
    city!,
    town!,
    apiVersion,
    option.allowParentOfChildren ?? false,
  )
  // TODO: rsdtと地番を両方対応した時に両方返すけど、今はrsdtを優先する
  if (normalizedAddrPart.rsdt) {
    addr = rsdtToString(normalizedAddrPart.rsdt)
    other = normalizedAddrPart.rest
    point = upgradePoint(
      point,
      rsdtOrChibanToResultPoint(normalizedAddrPart.rsdt),
    )
    level = 8
  } else if (normalizedAddrPart.chiban) {
    addr = chibanToString(normalizedAddrPart.chiban)
    other = normalizedAddrPart.rest
    point = upgradePoint(
      point,
      rsdtOrChibanToResultPoint(normalizedAddrPart.chiban),
    )
    level = 8
  } else if (normalizedAddrPart.parent) {
    addr = normalizedAddrPart.parent.addr
    other = normalizedAddrPart.rest
    point = upgradePoint(point, normalizedAddrPart.parent.point)
    addrSource = 'parent-of-children'
    level = 8
  }
  const result: NormalizeResult = {
    pref: pref ? prefectureName(pref) : undefined,
    city: city ? cityName(city) : undefined,
    town: town ? machiAzaName(town) : undefined,
    addr,
    // 完全一致以外の規則で確定したときだけ付ける（既存の結果の形を変えない）
    ...(addrSource ? { addrSource } : {}),
    level,
    point,
    other,
    metadata: {
      input: address,
      prefecture: removeCitiesFromPrefecture(pref),
      city: city,
      machiAza: removeExtraFromMachiAza(town),
      rsdt: normalizedAddrPart.rsdt,
      chiban: normalizedAddrPart.chiban,
      ...(normalizedAddrPart.parent
        ? { parentOfChildren: normalizedAddrPart.parent.evidence }
        : {}),
    },
  }
  return result
}
