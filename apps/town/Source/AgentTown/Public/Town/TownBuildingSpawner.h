#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "TownBuildingSpawner.generated.h"

class UStaticMesh;

namespace TownVisualLayout
{
	enum class EPlaceholderShape : uint8
	{
		Cube,
		Cylinder,
		FlatCube,
		TallCylinder,
	};

	struct FPlaceholderDef
	{
		double OffsetX = 0.0;
		double OffsetZ = 0.0;
		float RotationYRad = 0.0f;
		float Scale = 1.0f;
		EPlaceholderShape Shape = EPlaceholderShape::Cube;
	};

	struct FRegionVisualDef
	{
		const TCHAR* RegionId = nullptr;
		FLinearColor ZoneColor;
		TArray<FPlaceholderDef> Buildings;
	};

	struct FGroundPatchDef
	{
		double WireX = 0.0;
		double WireY = 0.0;
		double WireZ = 0.0;
		double SizeX = 0.0;
		double SizeZ = 0.0;
		FLinearColor Color;
		float Elevation = 0.5f;
	};
}

/** Runtime placeholder buildings, roads, and zone lots — mirrors Desktop regionLayout + townGround. */
UCLASS(NotPlaceable)
class AGENTTOWN_API ATownBuildingSpawner : public AActor
{
	GENERATED_BODY()

public:
	ATownBuildingSpawner();

	/** Spawn roads, zone grounds, and per-region placeholder buildings (engine basic shapes). */
	void BuildTownVisuals();

private:
	using EPlaceholderShape = TownVisualLayout::EPlaceholderShape;
	using FPlaceholderDef = TownVisualLayout::FPlaceholderDef;
	using FRegionVisualDef = TownVisualLayout::FRegionVisualDef;
	using FGroundPatchDef = TownVisualLayout::FGroundPatchDef;

	bool LoadRegionAnchors(TMap<FString, FVector>& OutAnchors) const;
	void SpawnRoadGrid();
	void SpawnZoneGrounds(const TMap<FString, FVector>& Anchors);
	void SpawnRegionBuildings(const TMap<FString, FVector>& Anchors);

	AStaticMeshActor* SpawnPlaceholder(
		UStaticMesh* CubeMesh,
		UStaticMesh* CylinderMesh,
		const FVector& WirePosition,
		float RotationYRad,
		float Scale,
		EPlaceholderShape Shape,
		const FLinearColor& Color,
		const FString& Label) const;

	void ApplyMeshColor(UPrimitiveComponent* Component, const FLinearColor& Color) const;

	static const TArray<TownVisualLayout::FRegionVisualDef>& GetRegionDefs();
	static const TArray<TownVisualLayout::FGroundPatchDef>& GetRoadPatches();
	static const TArray<TownVisualLayout::FGroundPatchDef>& GetZoneGroundPatches();

	UPROPERTY()
	TObjectPtr<UStaticMesh> CubeMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> CylinderMesh;

	UPROPERTY()
	TObjectPtr<UStaticMesh> PlaneMesh;
};
