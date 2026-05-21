import { build as esbuild } from 'esbuild'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const sourceRoot = projectRoot
const stagingRoot = path.join(projectRoot, '.extension-package')
const packageRoot = path.join(stagingRoot, 'memact-extension')
const outputZip = path.join(projectRoot, 'artifacts', 'memact-extension.zip')

async function ensureCleanDir(targetPath) {
  await fs.rm(targetPath, { recursive: true, force: true })
  await fs.mkdir(targetPath, { recursive: true })
}

async function copyRecursive(source, destination) {
  const stats = await fs.stat(source)
  if (stats.isDirectory()) {
    await fs.mkdir(destination, { recursive: true })
    const entries = await fs.readdir(source, { withFileTypes: true })
    for (const entry of entries) {
      await copyRecursive(
        path.join(source, entry.name),
        path.join(destination, entry.name)
      )
    }
    return
  }

  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.copyFile(source, destination)
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
    })

    child.on('error', reject)
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
        return
      }
      reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

async function createZipArchive() {
  await fs.mkdir(path.dirname(outputZip), { recursive: true })
  await fs.rm(outputZip, { force: true })

  if (process.platform === 'win32') {
    const command = [
      `$src = '${packageRoot.replace(/'/g, "''")}'`,
      `$dest = '${outputZip.replace(/'/g, "''")}'`,
      "if (Test-Path $dest) { Remove-Item -Force $dest }",
      "Compress-Archive -Path (Join-Path $src '*') -DestinationPath $dest -Force",
    ].join('; ')

    await runCommand('powershell.exe', ['-NoProfile', '-Command', command])
    return
  }

  const pythonScript = [
    'import os, sys, zipfile',
    'src = sys.argv[1]',
    'dest = sys.argv[2]',
    'with zipfile.ZipFile(dest, "w", zipfile.ZIP_DEFLATED) as zf:',
    '    for root, _, files in os.walk(src):',
    '        for name in files:',
    '            full = os.path.join(root, name)',
    '            arc = os.path.relpath(full, src)',
    '            zf.write(full, arc)',
  ].join('\n')

  try {
    await runCommand('python3', ['-c', pythonScript, packageRoot, outputZip])
  } catch {
    await runCommand('python', ['-c', pythonScript, packageRoot, outputZip])
  }
}

async function bundleExtension() {
  await ensureCleanDir(packageRoot)

  const manifest = JSON.parse(
    await fs.readFile(path.join(sourceRoot, 'manifest.json'), 'utf8')
  )
  await fs.writeFile(
    path.join(packageRoot, 'manifest.json'),
    JSON.stringify(manifest)
  )

  await esbuild({
    entryPoints: [path.join(sourceRoot, 'background.js')],
    outfile: path.join(packageRoot, 'background.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome109'],
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
    external: [
      './vendor/flexsearch/index.js',
      './vendor/flexsearch/*',
    ],
  })

  await esbuild({
    entryPoints: [path.join(sourceRoot, 'bridge.js')],
    outfile: path.join(packageRoot, 'bridge.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome109'],
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
  })

  await esbuild({
    entryPoints: [path.join(sourceRoot, 'embed-worker.js')],
    outfile: path.join(packageRoot, 'embed-worker.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome109'],
    minify: true,
    legalComments: 'none',
    charset: 'utf8',
  })

  await copyRecursive(path.join(sourceRoot, 'icons'), path.join(packageRoot, 'icons'))
  await copyRecursive(path.join(sourceRoot, 'vendor'), path.join(packageRoot, 'vendor'))
  await copyRecursive(
    path.join(sourceRoot, 'Readability.js'),
    path.join(packageRoot, 'Readability.js')
  )
  await copyRecursive(
    path.join(sourceRoot, 'page-api.js'),
    path.join(packageRoot, 'page-api.js')
  )
}

async function main() {
  try {
    await runCommand('node', ['scripts/sync-vendors.mjs'])
    await bundleExtension()
    await createZipArchive()
    console.log(`Created ${path.relative(projectRoot, outputZip)}`)
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
