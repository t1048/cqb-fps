import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import {
  BASE_SHIELD_COMBAT,
  BASE_SHIELD_MOBILITY,
  BASE_SWAT_COMBAT,
  BASE_SWAT_MOBILITY,
  SWAT_C2_BEEP_INTERVAL,
  SWAT_C2_BLAST_HALF_ANGLE_DEG,
  SWAT_C2_BLAST_RADIUS,
  SWAT_C2_FUSE_SEC,
  SWAT_C2_MAX_DAMAGE,
  SWAT_C2_PLANT_SEC,
  SWAT_C2_URGENT_AT_SEC,
  SWAT_C2_URGENT_BEEP_INTERVAL,
  SWAT_FLASH_CARRY_MAX,
  SWAT_FLASH_MAX_DIST,
  SWAT_FLASH_MIN_DIST,
  SWAT_FLASH_PER_TEAM,
  SWAT_FOOTSTEP_STRIDE_FAST,
  SWAT_FOOTSTEP_STRIDE_NORMAL,
  SWAT_GAS_MAX_DIST,
  SWAT_GAS_MIN_DIST,
  SWAT_GAS_PER_TEAM,
  SWAT_HP,
  SWAT_PEPPER_INTERVAL,
  SWAT_PEPPER_RANGE,
  SWAT_RADIO_STAGGER_SEC,
  SWAT_READY_POSE,
  SWAT_RUSH_DURATION_SEC,
  SWAT_RUSH_LOW_HP,
  SWAT_RUSH_RADIUS,
  SWAT_RUSH_SPEED_MAX,
  SWAT_RUSH_SPEED_MIN,
  SWAT_RUSH_TEAM_COOLDOWN,
  SWAT_SHIELD_RUSH_SPEED,
  SWAT_SUPPRESS_END_SEC,
  SWAT_SUPPRESS_INTERVAL,
  SWAT_SUPPRESS_START_SEC,
  SWAT_UNIFORM_COLOR,
  cloneCombatProfile,
  cloneMobilityProfile,
  isShieldRole,
} from '../../src/ai/SwatProfile';
import * as SwatTactics from '../../src/ai/SwatTactics';
import { LASER_MAX_DIST, TacticalOptics } from '../../src/ai/TacticalOptics';
import * as SwatTeamModule from '../../src/modes/SwatTeam';
import type { Collider } from '../../src/world/WorldBuilder';

describe('SwatProfile immutable base templates & cloning', () => {
  it('freezes all base combat and mobility templates at runtime', () => {
    expect(Object.isFrozen(BASE_SWAT_COMBAT)).toBe(true);
    expect(Object.isFrozen(BASE_SWAT_MOBILITY)).toBe(true);
    expect(Object.isFrozen(BASE_SHIELD_COMBAT)).toBe(true);
    expect(Object.isFrozen(BASE_SHIELD_MOBILITY)).toBe(true);

    expect(() => {
      (BASE_SWAT_COMBAT as { fireInterval: number }).fireInterval = 0.99;
    }).toThrow(TypeError);
    expect(() => {
      (BASE_SHIELD_COMBAT as { shotDamage: number }).shotDamage = 999;
    }).toThrow(TypeError);
    expect(() => {
      (BASE_SWAT_MOBILITY as { flankChance: number }).flankChance = 0;
    }).toThrow(TypeError);
    expect(() => {
      (BASE_SHIELD_MOBILITY as { flankChance: number }).flankChance = 1;
    }).toThrow(TypeError);
  });

  it('defines expected baseline rifleman and shield pointman combat & mobility values', () => {
    expect(BASE_SWAT_COMBAT).toEqual({
      decisionSec: 0.7,
      alertCalmSec: 10,
      hesitateFireSec: 3,
      hesitateRetreatSpeed: 0.8,
      hesitateRetreatMax: 1.5,
      hesitateShakeDeg: 0,
      moveSpeed: 2.35,
      fireInterval: 0.2,
      shotsPerPeek: 4,
      magazineSize: 30,
      reloadSec: 2.2,
      coverSecMin: 0.9,
      coverSecMax: 1.8,
      peekSecMax: 1.4,
      engageRange: 18,
      coverSearchRange: 6,
      coverMargin: 0.45,
      crouchCoverMaxHeight: 1.5,
      flinchSec: 0.35,
      gunshotNoiseRadius: 40,
      shotDamage: 13,
      baseSpreadDeg: 3.2,
    });

    expect(BASE_SHIELD_COMBAT).toEqual({
      ...BASE_SWAT_COMBAT,
      moveSpeed: 1.95,
      fireInterval: 0.32,
      shotsPerPeek: 5,
      magazineSize: 15,
      reloadSec: 1.8,
      coverSecMin: 0.25,
      coverSecMax: 0.5,
      peekSecMax: 2.4,
      coverSearchRange: 0,
      flinchSec: 0.06,
      shotDamage: 9,
      baseSpreadDeg: 2.6,
    });

    expect(BASE_SWAT_MOBILITY).toEqual({
      canOpenDoors: true,
      canUseStairs: true,
      patrolChance: 0,
      patrolIntervalMin: 99,
      patrolIntervalMax: 99,
      patrolSpeedScale: 0.6,
      investigateChance: 1,
      investigateMaxDist: 40,
      investigateSpeedScale: 0.9,
      reinforceOnGunshot: true,
      repositionAfterLostSec: 1.6,
      flankChance: 0.5,
      guardHostageRoom: false,
    });

    expect(BASE_SHIELD_MOBILITY).toEqual({
      ...BASE_SWAT_MOBILITY,
      repositionAfterLostSec: 0.5,
      flankChance: 0,
    });
  });

  it('cloneCombatProfile and cloneMobilityProfile return isolated mutable copies', () => {
    const combatA = cloneCombatProfile(BASE_SWAT_COMBAT);
    const combatB = cloneCombatProfile(BASE_SWAT_COMBAT);
    expect(combatA).toEqual(BASE_SWAT_COMBAT);
    expect(combatA).not.toBe(BASE_SWAT_COMBAT);
    expect(combatA).not.toBe(combatB);
    expect(Object.isFrozen(combatA)).toBe(false);

    combatA.moveSpeed = 3.5;
    combatA.fireInterval = 0.1;
    expect(BASE_SWAT_COMBAT.moveSpeed).toBe(2.35);
    expect(combatB.moveSpeed).toBe(2.35);

    const mobA = cloneMobilityProfile(BASE_SWAT_MOBILITY);
    const mobB = cloneMobilityProfile(BASE_SWAT_MOBILITY);
    expect(mobA).toEqual(BASE_SWAT_MOBILITY);
    expect(mobA).not.toBe(BASE_SWAT_MOBILITY);
    expect(mobA).not.toBe(mobB);
    expect(Object.isFrozen(mobA)).toBe(false);

    mobA.flankChance = 0.9;
    expect(BASE_SWAT_MOBILITY.flankChance).toBe(0.5);
    expect(mobB.flankChance).toBe(0.5);
  });

  it('isShieldRole assigns shield only to index 0 when total >= 2', () => {
    expect(isShieldRole(0, 0)).toBe(false);
    expect(isShieldRole(0, 1)).toBe(false);
    expect(isShieldRole(0, 2)).toBe(true);
    expect(isShieldRole(1, 2)).toBe(false);
    expect(isShieldRole(0, 4)).toBe(true);
    expect(isShieldRole(2, 4)).toBe(false);
    expect(isShieldRole(-1, 4)).toBe(false);
  });

  it('exports all shared SWAT condition, tactical, and presentation constants', () => {
    expect(SWAT_HP).toBe(100);
    expect(SWAT_UNIFORM_COLOR).toBe(0x2b3440);
    expect(SWAT_READY_POSE).toBe('high');

    expect(SWAT_PEPPER_INTERVAL).toBe(0.42);
    expect(SWAT_PEPPER_RANGE).toBe(20);

    expect(SWAT_RUSH_LOW_HP).toBe(40);
    expect(SWAT_RUSH_RADIUS).toBe(14);
    expect(SWAT_RUSH_DURATION_SEC).toBe(5.5);
    expect(SWAT_RUSH_TEAM_COOLDOWN).toBe(6.0);
    expect(SWAT_RUSH_SPEED_MIN).toBe(2.7);
    expect(SWAT_RUSH_SPEED_MAX).toBe(2.9);
    expect(SWAT_SHIELD_RUSH_SPEED).toBe(2.35);

    expect(SWAT_SUPPRESS_START_SEC).toBe(0.35);
    expect(SWAT_SUPPRESS_END_SEC).toBe(3.5);
    expect(SWAT_SUPPRESS_INTERVAL).toBe(0.5);

    expect(SWAT_C2_PLANT_SEC).toBe(0.8);
    expect(SWAT_C2_FUSE_SEC).toBe(1.8);
    expect(SWAT_C2_URGENT_AT_SEC).toBe(1.1);
    expect(SWAT_C2_BEEP_INTERVAL).toBe(0.45);
    expect(SWAT_C2_URGENT_BEEP_INTERVAL).toBe(0.2);
    expect(SWAT_C2_BLAST_RADIUS).toBe(4.5);
    expect(SWAT_C2_BLAST_HALF_ANGLE_DEG).toBe(70);
    expect(SWAT_C2_MAX_DAMAGE).toBe(45);

    expect(SWAT_FLASH_PER_TEAM).toBe(3);
    expect(SWAT_FLASH_CARRY_MAX).toBe(4);
    expect(SWAT_FLASH_MIN_DIST).toBe(3.2);
    expect(SWAT_FLASH_MAX_DIST).toBe(9);

    expect(SWAT_GAS_PER_TEAM).toBe(3);
    expect(SWAT_GAS_MIN_DIST).toBe(2.0);
    expect(SWAT_GAS_MAX_DIST).toBe(13.0);

    expect(SWAT_RADIO_STAGGER_SEC).toBe(1.25);
    expect(SWAT_FOOTSTEP_STRIDE_FAST).toBe(0.85);
    expect(SWAT_FOOTSTEP_STRIDE_NORMAL).toBe(1.05);
  });
});

describe('TacticalOptics zero-dynamic-light invariant & behavior', () => {
  it('contains zero dynamic lights and uses additive MeshBasicMaterial with depthWrite=false', () => {
    const optics = new TacticalOptics();
    let lightCount = 0;
    const meshes: THREE.Mesh[] = [];
    optics.group.traverse((obj) => {
      if ((obj as THREE.Light).isLight) lightCount++;
      if ((obj as THREE.Mesh).isMesh) meshes.push(obj as THREE.Mesh);
    });
    expect(lightCount).toBe(0);
    expect(meshes).toHaveLength(3);
    for (const mesh of meshes) {
      expect(mesh.material).toBeInstanceOf(THREE.MeshBasicMaterial);
      const mat = mesh.material as THREE.MeshBasicMaterial;
      expect(mat.blending).toBe(THREE.AdditiveBlending);
      expect(mat.depthWrite).toBe(false);
      expect(mat.transparent).toBe(true);
    }
    optics.dispose();
  });

  it('updates laser and impact dot on open space vs wall hit, keeps the flashlight cone hidden, and hides/disposes cleanly', () => {
    const parent = new THREE.Group();
    const optics = new TacticalOptics();
    parent.add(optics.group);
    expect(optics.group.visible).toBe(false);
    expect(optics.coneMesh.visible).toBe(false);

    // Open space: full laser length, no impact dot. Flashlight cone stays hidden.
    optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, []);
    expect(optics.group.visible).toBe(true);
    expect(optics.laserMesh.visible).toBe(true);
    expect(optics.laserMesh.scale.z).toBeCloseTo(LASER_MAX_DIST, 3);
    expect(optics.dotMesh.visible).toBe(false);
    expect(optics.coneMesh.visible).toBe(false);

    // Wall at z = -5: laser clipped to 5m, impact dot visible near z = -4.985
    const wall: Collider = {
      kind: 'wall',
      aabb: new THREE.Box3(new THREE.Vector3(-4, 0, -5.2), new THREE.Vector3(4, 3, -5.0)),
    };
    optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, [wall]);
    expect(optics.laserMesh.scale.z).toBeCloseTo(5.0, 2);
    expect(optics.dotMesh.visible).toBe(true);
    expect(optics.dotMesh.position.z).toBeCloseTo(-4.985, 2);
    expect(optics.coneMesh.visible).toBe(false);

    // Zero-length direction hides optics safely
    optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: 0 }, [wall]);
    expect(optics.group.visible).toBe(false);

    // Explicit hide() & dispose()
    optics.update({ x: 0, y: 1.4, z: 0 }, { x: 0, y: 0, z: -1 }, []);
    optics.hide();
    expect(optics.group.visible).toBe(false);
    expect(optics.laserMesh.visible).toBe(false);
    expect(optics.dotMesh.visible).toBe(false);
    expect(optics.coneMesh.visible).toBe(false);

    optics.dispose();
    expect(optics.group.parent).toBeNull();
  });
});

describe('SwatTeam backwards-compatible re-exports', () => {
  it('re-exports every extracted tactical planner and constant by identity', () => {
    expect(SwatTeamModule.isIndoorPoint).toBe(SwatTactics.isIndoorPoint);
    expect(SwatTeamModule.listExteriorEntries).toBe(SwatTactics.listExteriorEntries);
    expect(SwatTeamModule.entryRouteDest).toBe(SwatTactics.entryRouteDest);
    expect(SwatTeamModule.computeBallisticVelocity).toBe(SwatTactics.computeBallisticVelocity);
    expect(SwatTeamModule.planDoorwayFlashThrow).toBe(SwatTactics.planDoorwayFlashThrow);
    expect(SwatTeamModule.planWindowFlashThrow).toBe(SwatTactics.planWindowFlashThrow);
    expect(SwatTeamModule.raycastWallXZ).toBe(SwatTactics.raycastWallXZ);
    expect(SwatTeamModule.planWallBankFlashThrow).toBe(SwatTactics.planWallBankFlashThrow);
    expect(SwatTeamModule.planFlashThrow).toBe(SwatTactics.planFlashThrow);
    expect(SwatTeamModule.filterReachableExteriorEntries).toBe(SwatTactics.filterReachableExteriorEntries);
    expect(SwatTeamModule.assignCellPortals).toBe(SwatTactics.assignCellPortals);
    expect(SwatTeamModule.buildStackSlotPortal).toBe(SwatTactics.buildStackSlotPortal);
    expect(SwatTeamModule.selectPinningCell).toBe(SwatTactics.selectPinningCell);
    expect(SwatTeamModule.findRoomDoors).toBe(SwatTactics.findRoomDoors);
    expect(SwatTeamModule.planPincerFlankGoal).toBe(SwatTactics.planPincerFlankGoal);
    expect(SwatTeamModule.C2_PRESSURE_THRESHOLD).toBe(SwatTactics.C2_PRESSURE_THRESHOLD);
    expect(SwatTeamModule.C2_MIN_LOCKED_DOORS).toBe(SwatTactics.C2_MIN_LOCKED_DOORS);
    expect(SwatTeamModule.C2_BLAST_RADIUS).toBe(SwatTactics.C2_BLAST_RADIUS);
    expect(SwatTeamModule.shouldUseC2Breach).toBe(SwatTactics.shouldUseC2Breach);
    expect(SwatTeamModule.computeC2Standoff).toBe(SwatTactics.computeC2Standoff);
    expect(SwatTeamModule.evaluateC2BlastCone).toBe(SwatTactics.evaluateC2BlastCone);
    expect(SwatTeamModule.RADIO_STAGGER_SEC).toBe(SWAT_RADIO_STAGGER_SEC);
  });

  it('initializes SWAT_COMBAT and SHIELD_COMBAT from base templates without aliasing BASE_*', () => {
    expect(SwatTeamModule.SWAT_COMBAT).toEqual(BASE_SWAT_COMBAT);
    expect(SwatTeamModule.SWAT_COMBAT).not.toBe(BASE_SWAT_COMBAT);
    expect(SwatTeamModule.SHIELD_COMBAT).toEqual(BASE_SHIELD_COMBAT);
    expect(SwatTeamModule.SHIELD_COMBAT).not.toBe(BASE_SHIELD_COMBAT);
  });
});
