// Frame-safe Zstandard reader for DSH v4 session logs.
//
// Node 24.21's zstdDecompressSync() stops after the first frame, while DSH logs
// are multi-frame (one frame per durable batch). This module walks the frame
// structure itself and decompresses each frame separately, so it works on both
// the DSH-bundled Node 24.21 and the system Node 24.22+.
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = 0xfd2fb528
const FCS_SIZES_SINGLE = [1, 2, 4, 8]
const FCS_SIZES_MULTI = [0, 2, 4, 8]
const DICT_SIZES = [0, 1, 2, 4]

function readFrameEnd(buffer, start) {
  let offset = start
  if (buffer.readUInt32LE(offset) !== MAGIC) throw new Error('not a zstd frame')
  offset += 4
  if (offset >= buffer.length) throw new Error('truncated frame header')
  const descriptor = buffer[offset]
  offset += 1
  const fcsFlag = (descriptor >> 6) & 3
  const singleSegment = (descriptor >> 5) & 1
  const checksum = (descriptor >> 2) & 1
  const dictFlag = descriptor & 3
  if (!singleSegment) {
    if (offset >= buffer.length) throw new Error('truncated window descriptor')
    offset += 1
  }
  const dictSize = DICT_SIZES[dictFlag]
  if (offset + dictSize > buffer.length) throw new Error('truncated dictionary id')
  offset += dictSize
  const fcsSize = singleSegment ? FCS_SIZES_SINGLE[fcsFlag] : FCS_SIZES_MULTI[fcsFlag]
  if (offset + fcsSize > buffer.length) throw new Error('truncated frame content size')
  offset += fcsSize

  let last = 0
  while (last === 0) {
    if (offset + 3 > buffer.length) throw new Error('truncated block header')
    const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
    offset += 3
    last = header & 1
    const type = (header >> 1) & 3
    const size = (header >> 3) & 0x1fffff
    if (type === 0) {
      if (offset + size > buffer.length) throw new Error('truncated raw block')
      offset += size
    } else if (type === 1) {
      if (offset + 1 > buffer.length) throw new Error('truncated rle block')
      offset += 1
    } else if (type === 2) {
      if (offset + size > buffer.length) throw new Error('truncated compressed block')
      offset += size
    } else {
      throw new Error('reserved zstd block type')
    }
  }
  if (checksum) {
    if (offset + 4 > buffer.length) throw new Error('truncated checksum')
    offset += 4
  }
  return offset
}

/**
 * Split a concatenated zstd buffer into complete frames. A trailing partially
 * written frame (the session is being appended to) is ignored, so a live log
 * can be read as a consistent prefix.
 */
export function splitZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    if (buffer.readUInt32LE(offset) !== MAGIC) break
    let end
    try {
      end = readFrameEnd(buffer, offset)
    } catch {
      break
    }
    frames.push(buffer.subarray(offset, end))
    offset = end
  }
  return frames
}

/** Decode all complete frames and return the JSONL rows. */
export function decodeZstdRows(buffer) {
  const frames = splitZstdFrames(buffer)
  const text = frames.map((frame) => zstdDecompressSync(frame).toString('utf8')).join('')
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line))
}

export function countZstdFrames(buffer) {
  return splitZstdFrames(buffer).length
}
