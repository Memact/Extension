import { copyFile, cp, mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')
const vendorDir = path.join(root, 'vendor')
const vendors = [
  {
    source: path.join(root, 'node_modules', 'dexie', 'dist', 'dexie.mjs'),
    target: path.join(vendorDir, 'dexie.mjs'),
    label: 'Dexie module',
  },
  {
    source: path.join(root, 'node_modules', 'flexsearch', 'dist', 'module-min'),
    target: path.join(vendorDir, 'flexsearch'),
    label: 'FlexSearch module',
    directory: true,
  },
  {
    source: path.join(root, 'node_modules', 'pdfjs-dist', 'legacy', 'build', 'pdf.min.mjs'),
    target: path.join(vendorDir, 'pdf.min.mjs'),
    label: 'PDF.js module',
  },
]

async function main() {
  await mkdir(vendorDir, { recursive: true })
  await rm(path.join(vendorDir, 'flexsearch.min.mjs'), { force: true })
  await rm(path.join(vendorDir, 'transformers.min.js'), { force: true })
  await rm(path.join(vendorDir, 'web-llm.mjs'), { force: true })

  for (const vendor of vendors) {
    try {
      if (vendor.directory) {
        await rm(vendor.target, { recursive: true, force: true })
        await cp(vendor.source, vendor.target, { recursive: true })
      } else {
        await copyFile(vendor.source, vendor.target)
      }
      console.log(`Synced ${vendor.label} to ${vendor.target}`)
    } catch (error) {
      console.warn(`Skipping ${vendor.label} sync:`, error?.message || error)
    }
  }
}

await main()
