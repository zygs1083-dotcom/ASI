/**
 * Generate the spike package's Typert artifacts with the DSH generator and
 * write them under packages/asi-sense-spike/lib/. DSH packages resolve
 * through this spike's node_modules links to the built clone, so imports land
 * on d.ts declarations outside this workspace root.
 */

import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dsh = process.env.DSH_ROOT ?? '/Users/wangying/orca/dsh'

const { writeWorkspaceArtifacts } = await import(`${dsh}/packages/typert/generator/src/artifact-files.ts`)
const { WorkspaceTypertGenerator } = await import(`${dsh}/packages/typert/generator/src/workspace.ts`)

const artifacts = new WorkspaceTypertGenerator(root, {
  checkDiagnostics: false,
  rejectBuildOutputs: true,
}).generateContributors(['host'])

writeWorkspaceArtifacts(root, artifacts)
for (const artifact of artifacts) {
  console.log(`typert(${artifact.face}): ${artifact.package} -> ${artifact.packageRoot}`)
}
console.log(`generate-typert: wrote ${artifacts.length} artifact(s)`)
