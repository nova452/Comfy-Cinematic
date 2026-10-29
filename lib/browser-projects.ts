/**
 * Projects, kept in this browser.
 *
 * The same rules as the old file store — one record per project, a project's
 * media deleted with it, a half-written save impossible — with IndexedDB in
 * place of a directory. One visitor's work is invisible to another because
 * there is nothing shared to see.
 */

import { deleteMedia } from "./browser-media.ts";
import { allRecords, deleteRecord, getRecord, PROJECT_STORE, putRecord, requestPersistence } from "./browser-db.ts";
import {
  isProjectId,
  normalizeProject,
  summarize,
  type Project,
  type ProjectSummary,
} from "./projects.ts";

export async function listProjects(): Promise<ProjectSummary[]> {
  let records: unknown[];
  try {
    records = await allRecords<unknown>(PROJECT_STORE);
  } catch {
    return [];
  }

  return records
    .map((record) => normalizeProject(record))
    .filter((project): project is Project => Boolean(project))
    .map(summarize)
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export async function readProject(id: string): Promise<Project | undefined> {
  if (!isProjectId(id)) return undefined;
  try {
    return normalizeProject(await getRecord<unknown>(PROJECT_STORE, id));
  } catch {
    return undefined;
  }
}

export async function writeProject(project: Project): Promise<void> {
  if (!isProjectId(project.id)) throw new Error("Invalid project id.");
  await putRecord(PROJECT_STORE, project);
  requestPersistence();
}

export async function deleteProject(id: string): Promise<boolean> {
  if (!isProjectId(id)) return false;

  // Read first: the frames and the library are the only record of which
  // blobs this project owns.
  const project = await readProject(id);
  try {
    await deleteRecord(PROJECT_STORE, id);
  } catch {
    return false;
  }

  await deleteMedia([
    ...(project?.frames ?? []).flatMap((frame) => [
      frame.src,
      ...(frame.characterSrcs ?? []),
      ...(frame.referenceSrcs ?? []),
      frame.backgroundSrc,
      frame.canvasSrc,
      frame.referenceSrc,
    ]),
    ...(project?.assets ?? []).map((asset) => asset.src),
  ]);

  return true;
}
