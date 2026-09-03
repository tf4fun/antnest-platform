export type ImmutableCatalogDetail<T> = {
  resource: T;
  historical: boolean;
};

export async function loadImmutableCatalogDetail<T, Revision>({
  revision,
  readCurrent,
  readRevision,
  assertOwner,
}: {
  revision: Revision | undefined;
  readCurrent: () => Promise<T>;
  readRevision: (revision: Revision) => Promise<T>;
  assertOwner: (resource: T) => void;
}): Promise<ImmutableCatalogDetail<T>> {
  const historical = revision !== undefined;
  const resource = historical
    ? await readRevision(revision)
    : await readCurrent();
  assertOwner(resource);
  return { resource, historical };
}
