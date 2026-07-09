#pragma once

#include "CoreMinimal.h"
#include "Town/TownRegionMarker.h"
#include "TownBootstrap.generated.h"

class ATownBuildingSpawner;

/** Procedural town setup: ground, roads, placeholder buildings, region markers. */
UCLASS()
class AGENTTOWN_API ATownBootstrap : public AActor
{
	GENERATED_BODY()

public:
	ATownBootstrap();

	virtual void BeginPlay() override;

	/** Spawn ground, visuals, region markers, and NavMesh (idempotent). */
	void BuildTown();

private:
	bool bTownBuilt = false;
	bool SpawnGroundPlane();
	bool SpawnRegionMarkers();
	bool SpawnTownVisuals();
	void BuildTownNavMesh();

	UPROPERTY()
	TObjectPtr<class ANavMeshBoundsVolume> NavMeshBounds;

	UPROPERTY()
	TArray<TObjectPtr<ATownRegionMarker>> RegionMarkers;

	UPROPERTY()
	TObjectPtr<ATownBuildingSpawner> BuildingSpawner;
};
