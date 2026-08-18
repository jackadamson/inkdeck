// Minimal header parsers so tests can assert encoded-image facts without a
// decoder dependency: PNG IHDR dims, JPEG SOF0 dims + chroma subsampling.

export interface ImageInfo {
  format: 'png' | 'jpeg'
  width: number
  height: number
  /** JPEG only: '4:4:4' when every component has 1×1 sampling. */
  chromaSubsampling?: string
}

export function imageInfo(bytes: Uint8Array): ImageInfo {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    // IHDR is always the first chunk: length(4) type(4) width(4) height(4)
    return { format: 'png', width: view.getUint32(16), height: view.getUint32(20) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 4 <= bytes.length) {
      if (bytes[offset] !== 0xff) throw new Error('bad JPEG marker')
      const marker = bytes[offset + 1]!
      const length = view.getUint16(offset + 2)
      if (marker >= 0xc0 && marker <= 0xc2) {
        const height = view.getUint16(offset + 5)
        const width = view.getUint16(offset + 7)
        const components = bytes[offset + 9]!
        let allOneByOne = true
        for (let c = 0; c < components; c++) {
          if (bytes[offset + 11 + c * 3] !== 0x11) allOneByOne = false
        }
        return { format: 'jpeg', width, height, chromaSubsampling: components === 1 || allOneByOne ? '4:4:4' : 'subsampled' }
      }
      offset += 2 + length
    }
    throw new Error('no SOF marker')
  }
  throw new Error('unrecognized image')
}
