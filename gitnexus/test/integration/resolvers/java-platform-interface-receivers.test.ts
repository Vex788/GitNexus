import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPipelineFromRepo } from '../../../src/core/ingestion/pipeline.js';
import type { PipelineResult } from '../../../src/types/pipeline.js';
import { getRelationships, writeFixtureRepo } from './helpers.js';

function callTargets(result: PipelineResult, caller: string, method: string): string[] {
  return getRelationships(result, 'CALLS')
    .filter((edge) => edge.source === caller && edge.target === method)
    .map((edge) => edge.rel.targetId)
    .sort();
}

/**
 * A class that implements a JDK interface with a closed member inventory (Serializable,
 * Cloneable, ...) must keep its `receiver.method()` edges. Before the fix the unindexed
 * interface made the whole hierarchy "incomplete" and every receiver call on the class,
 * and on every subclass of it, was suppressed as overload-unknown.
 */
describe('Java receiver calls on classes with platform interfaces', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'gitnexus-java-platform-iface-'));
  let result: PipelineResult;

  beforeAll(async () => {
    writeFixtureRepo(root, {
      'm/Base.java': `package m;
import java.io.Serializable;
public class Base implements Serializable {
  public Long getId() { return null; }
}`,
      'm/Mpp.java': `package m;
public class Mpp extends Base {
  public Double getMax() { return null; }
  public boolean normalize() { return false; }
}`,
      'm/Marker.java': `package m;
public class Marker implements java.io.Serializable, Cloneable {
  public int size() { return 0; }
}`,
      'm/Ordered.java': `package m;
public class Ordered implements Comparable<Ordered> {
  public int size() { return 0; }
  public int compareTo(Ordered other) { return 0; }
}`,
      'm/ExternalBase.java': `package m;
import com.ext.LibraryBase;
public class ExternalBase extends LibraryBase {
  public int size() { return 0; }
}`,
      'r/Repricer.java': `package r;
import m.Mpp;
import m.Marker;
import m.Ordered;
import m.ExternalBase;
public class Repricer {
  static void heal(Mpp mpp) {
    if (mpp.normalize()) { System.out.println(mpp.getId()); }
  }
  Double max(Mpp mpp) { return mpp.getMax(); }
  int viaMarker(Marker marker) { return marker.size(); }
  int viaOrdered(Ordered o, Ordered p) { return o.size() + o.compareTo(p); }
  int viaExternal(ExternalBase e) { return e.size(); }
}`,
    });
    result = await runPipelineFromRepo(root, () => {});
  }, 120_000);

  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it('resolves a member declared on the receiver class itself', () => {
    expect(callTargets(result, 'heal', 'normalize')).toHaveLength(1);
    expect(callTargets(result, 'max', 'getMax')).toHaveLength(1);
  });

  it('resolves a member inherited through a Serializable superclass', () => {
    expect(callTargets(result, 'heal', 'getId')).toHaveLength(1);
  });

  it('resolves through several marker interfaces', () => {
    expect(callTargets(result, 'viaMarker', 'size')).toHaveLength(1);
  });

  it('resolves a name the platform interface does not declare', () => {
    expect(callTargets(result, 'viaOrdered', 'size')).toHaveLength(1);
  });

  it('keeps the conservative outcome for a name the platform interface declares', () => {
    expect(callTargets(result, 'viaOrdered', 'compareTo')).toHaveLength(0);
  });

  it('keeps the conservative outcome for an unknown external superclass', () => {
    expect(callTargets(result, 'viaExternal', 'size')).toHaveLength(0);
  });
});
