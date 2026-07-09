#include "Town/TownBuildingSpawner.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/StaticMesh.h"
#include "Components/StaticMeshComponent.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/Material.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Simulation/WireCoordinateTransform.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace TownVisualLayout
{
	static FPlaceholderDef P(
		double Dx,
		double Dz,
		float RotY = 0.0f,
		float Scale = 1.0f,
		EPlaceholderShape Shape = EPlaceholderShape::Cube)
	{
		return {Dx, Dz, RotY, Scale, Shape};
	}

	static FGroundPatchDef Road(
		double X,
		double Z,
		double W,
		double D,
		FLinearColor Color,
		float Elev = 0.6f)
	{
		return {X, 0.004, Z, W, D, Color, Elev};
	}

	static FGroundPatchDef Zone(
		double X,
		double Z,
		double W,
		double D,
		FLinearColor Color,
		float Elev = 0.8f)
	{
		return {X, 0.007, Z, W, D, Color, Elev};
	}
} // namespace TownVisualLayout

ATownBuildingSpawner::ATownBuildingSpawner()
{
	PrimaryActorTick.bCanEverTick = false;

	CubeMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube"));
	CylinderMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	PlaneMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Plane.Plane"));
}

void ATownBuildingSpawner::BuildTownVisuals()
{
	if (!CubeMesh || !CylinderMesh || !PlaneMesh)
	{
		UE_LOG(LogTemp, Warning, TEXT("TownBuildingSpawner: missing engine basic meshes"));
		return;
	}

	TMap<FString, FVector> Anchors;
	if (!LoadRegionAnchors(Anchors))
	{
		return;
	}

	SpawnRoadGrid();
	SpawnZoneGrounds(Anchors);
	SpawnRegionBuildings(Anchors);
}

bool ATownBuildingSpawner::LoadRegionAnchors(TMap<FString, FVector>& OutAnchors) const
{
	const FString FixturePath = FPaths::Combine(
		FPaths::ProjectContentDir(),
		TEXT("Fixtures/simulation-region-positions.json"));

	FString JsonText;
	if (!FFileHelper::LoadFileToString(JsonText, *FixturePath))
	{
		UE_LOG(LogTemp, Warning, TEXT("TownBuildingSpawner: missing fixture %s"), *FixturePath);
		return false;
	}

	TSharedPtr<FJsonObject> Root;
	const TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(JsonText);
	if (!FJsonSerializer::Deserialize(Reader, Root) || !Root.IsValid())
	{
		return false;
	}

	const TSharedPtr<FJsonObject>* RegionsObj = nullptr;
	if (!Root->TryGetObjectField(TEXT("regions"), RegionsObj) || !RegionsObj->IsValid())
	{
		return false;
	}

	for (const TPair<FString, TSharedPtr<FJsonValue>>& Entry : (*RegionsObj)->Values)
	{
		const TSharedPtr<FJsonObject>* PosObj = nullptr;
		if (!Entry.Value->TryGetObject(PosObj) || !PosObj->IsValid())
		{
			continue;
		}

		double X = 0.0;
		double Y = 0.0;
		double Z = 0.0;
		(*PosObj)->TryGetNumberField(TEXT("x"), X);
		(*PosObj)->TryGetNumberField(TEXT("y"), Y);
		(*PosObj)->TryGetNumberField(TEXT("z"), Z);
		OutAnchors.Add(Entry.Key, FWireCoordinateTransform::ToUnreal(X, Y, Z));
	}

	return OutAnchors.Num() > 0;
}

void ATownBuildingSpawner::SpawnRoadGrid()
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return;
	}

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	int32 Index = 0;
	for (const FGroundPatchDef& Patch : GetRoadPatches())
	{
		const FVector UeCenter = FWireCoordinateTransform::ToUnreal(Patch.WireX, Patch.WireY, Patch.WireZ);

		AStaticMeshActor* Road = World->SpawnActor<AStaticMeshActor>(
			AStaticMeshActor::StaticClass(),
			FVector(UeCenter.X, UeCenter.Y, Patch.Elevation),
			FRotator::ZeroRotator,
			Params);
		if (!Road)
		{
			continue;
		}

		UStaticMeshComponent* Mesh = Road->GetStaticMeshComponent();
		Mesh->SetStaticMesh(PlaneMesh);
		Mesh->SetWorldScale3D(FVector(
			static_cast<float>(Patch.SizeX),
			static_cast<float>(Patch.SizeZ),
			1.0f));
		Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		ApplyMeshColor(Mesh, Patch.Color);
		Road->SetActorLabel(FString::Printf(TEXT("Road_%d"), Index++));
	}
}

void ATownBuildingSpawner::SpawnZoneGrounds(const TMap<FString, FVector>& /*Anchors*/)
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return;
	}

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	int32 Index = 0;
	for (const FGroundPatchDef& Patch : GetZoneGroundPatches())
	{
		const FVector UeCenter = FWireCoordinateTransform::ToUnreal(Patch.WireX, Patch.WireY, Patch.WireZ);

		AStaticMeshActor* Zone = World->SpawnActor<AStaticMeshActor>(
			AStaticMeshActor::StaticClass(),
			FVector(UeCenter.X, UeCenter.Y, Patch.Elevation),
			FRotator::ZeroRotator,
			Params);
		if (!Zone)
		{
			continue;
		}

		UStaticMeshComponent* Mesh = Zone->GetStaticMeshComponent();
		Mesh->SetStaticMesh(PlaneMesh);
		Mesh->SetWorldScale3D(FVector(
			static_cast<float>(Patch.SizeX),
			static_cast<float>(Patch.SizeZ),
			1.0f));
		Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		ApplyMeshColor(Mesh, Patch.Color);
		Zone->SetActorLabel(FString::Printf(TEXT("ZoneGround_%d"), Index++));
	}
}

void ATownBuildingSpawner::SpawnRegionBuildings(const TMap<FString, FVector>& Anchors)
{
	for (const FRegionVisualDef& Region : GetRegionDefs())
	{
		const FString RegionKey(Region.RegionId);
		const FVector* AnchorUe = Anchors.Find(RegionKey);
		if (!AnchorUe)
		{
			UE_LOG(LogTemp, Warning, TEXT("TownBuildingSpawner: missing anchor for %s"), *RegionKey);
			continue;
		}

		// Recover wire anchor from scaled UE (inverse of ToUnreal).
		const double AnchorWireX = AnchorUe->X / FWireCoordinateTransform::WorldScale;
		const double AnchorWireZ = -AnchorUe->Y / FWireCoordinateTransform::WorldScale;

		int32 BuildingIndex = 0;
		for (const FPlaceholderDef& Def : Region.Buildings)
		{
			const FVector WirePos(
				AnchorWireX + Def.OffsetX,
				0.0,
				AnchorWireZ + Def.OffsetZ);

			const FString Label = FString::Printf(TEXT("%s_%d"), *RegionKey, BuildingIndex++);
			SpawnPlaceholder(
				CubeMesh,
				CylinderMesh,
				WirePos,
				Def.RotationYRad,
				Def.Scale,
				Def.Shape,
				Region.ZoneColor,
				Label);
		}
	}
}

AStaticMeshActor* ATownBuildingSpawner::SpawnPlaceholder(
	UStaticMesh* InCubeMesh,
	UStaticMesh* InCylinderMesh,
	const FVector& WirePosition,
	float RotationYRad,
	float Scale,
	EPlaceholderShape Shape,
	const FLinearColor& Color,
	const FString& Label) const
{
	UWorld* World = GetWorld();
	if (!World || !InCubeMesh || !InCylinderMesh)
	{
		return nullptr;
	}

	const FVector UeBase = FWireCoordinateTransform::ToUnreal(WirePosition.X, WirePosition.Y, WirePosition.Z);
	const float YawDeg = FMath::RadiansToDegrees(RotationYRad);

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	AStaticMeshActor* Actor = World->SpawnActor<AStaticMeshActor>(
		AStaticMeshActor::StaticClass(),
		UeBase,
		FRotator(0.0f, YawDeg, 0.0f),
		Params);
	if (!Actor)
	{
		return nullptr;
	}

	UStaticMeshComponent* Mesh = Actor->GetStaticMeshComponent();
	FVector MeshScale(1.0f);

	switch (Shape)
	{
	case EPlaceholderShape::Cube:
		Mesh->SetStaticMesh(InCubeMesh);
		MeshScale = FVector(2.8f * Scale, 2.8f * Scale, 3.6f * Scale);
		Actor->AddActorWorldOffset(FVector(0.0f, 0.0f, 180.0f * Scale));
		break;
	case EPlaceholderShape::FlatCube:
		Mesh->SetStaticMesh(InCubeMesh);
		MeshScale = FVector(3.5f * Scale, 1.2f * Scale, 0.4f * Scale);
		Actor->AddActorWorldOffset(FVector(0.0f, 0.0f, 20.0f * Scale));
		break;
	case EPlaceholderShape::Cylinder:
		Mesh->SetStaticMesh(InCylinderMesh);
		MeshScale = FVector(1.2f * Scale, 1.2f * Scale, 0.25f * Scale);
		Actor->AddActorWorldOffset(FVector(0.0f, 0.0f, 12.0f * Scale));
		break;
	case EPlaceholderShape::TallCylinder:
		Mesh->SetStaticMesh(InCylinderMesh);
		MeshScale = FVector(2.2f * Scale, 2.2f * Scale, 6.5f * Scale);
		Actor->AddActorWorldOffset(FVector(0.0f, 0.0f, 325.0f * Scale));
		break;
	default:
		break;
	}

	Mesh->SetRelativeScale3D(MeshScale);
	Mesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	ApplyMeshColor(Mesh, Color);
	Actor->SetActorLabel(Label);
	return Actor;
}

void ATownBuildingSpawner::ApplyMeshColor(UPrimitiveComponent* Component, const FLinearColor& Color) const
{
	if (!Component)
	{
		return;
	}

	UMaterialInterface* Parent = LoadObject<UMaterial>(
		nullptr,
		TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (!Parent)
	{
		return;
	}

	UMaterialInstanceDynamic* DynMat = UMaterialInstanceDynamic::Create(Parent, Component);
	DynMat->SetVectorParameterValue(TEXT("Color"), Color);
	Component->SetMaterial(0, DynMat);
}

const TArray<TownVisualLayout::FGroundPatchDef>& ATownBuildingSpawner::GetRoadPatches()
{
	using namespace TownVisualLayout;
	static const TArray<FGroundPatchDef> Roads = {
		Road(8, 0, 72, 5, FLinearColor(0.42f, 0.45f, 0.48f)),
		Road(0, 6, 5, 52, FLinearColor(0.42f, 0.45f, 0.48f)),
		Road(24, 0, 14, 4, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(30, 6, 18, 4, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(36, 8, 4, 12, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(24, -6, 14, 4, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(24, -10, 4, 10, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(6, 18, 4, 16, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(12, 22, 12, 4, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(-6, -5, 16, 4, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(-12, -8, 4, 10, FLinearColor(0.45f, 0.48f, 0.51f)),
		Road(-9, 6, 14, 3, FLinearColor(0.54f, 0.58f, 0.53f)),
		Road(-18, 4, 3, 12, FLinearColor(0.54f, 0.58f, 0.53f)),
	};
	return Roads;
}

const TArray<TownVisualLayout::FGroundPatchDef>& ATownBuildingSpawner::GetZoneGroundPatches()
{
	using namespace TownVisualLayout;
	static const TArray<FGroundPatchDef> Zones = {
		Zone(0, 0, 12, 12, FLinearColor(0.72f, 0.77f, 0.81f)),
		Zone(24, 0, 14, 12, FLinearColor(0.77f, 0.72f, 0.66f)),
		Zone(36, 12, 12, 10, FLinearColor(0.83f, 0.77f, 0.69f)),
		Zone(24, -12, 14, 10, FLinearColor(0.69f, 0.72f, 0.75f)),
		Zone(12, 24, 16, 14, FLinearColor(0.66f, 0.77f, 0.63f)),
		Zone(-12, -10, 14, 12, FLinearColor(0.69f, 0.72f, 0.78f)),
		Zone(-18, 6, 16, 12, FLinearColor(0.42f, 0.68f, 0.42f)),
	};
	return Zones;
}

const TArray<TownVisualLayout::FRegionVisualDef>& ATownBuildingSpawner::GetRegionDefs()
{
	using namespace TownVisualLayout;
	static const TArray<FRegionVisualDef> Regions = {
		{
			TEXT("广场"),
			FLinearColor(0.61f, 0.64f, 0.68f),
			{
				P(-5, -5, PI / 2, 1.0f),
				P(5, -5, -PI / 2, 1.0f),
				P(-5, 5, PI, 1.0f),
				P(5, 5, 0.0f, 1.0f),
				P(0, -5, PI, 0.95f),
				P(0, 5, 0.0f, 0.95f),
				P(-5, 0, PI / 2, 0.9f),
				P(5, 0, -PI / 2, 0.9f),
				P(-2, 1, 0.0f, 0.8f, EPlaceholderShape::Cylinder),
				P(2, -1, 0.8f, 0.8f, EPlaceholderShape::Cylinder),
				P(0, 2, 1.5f, 0.8f, EPlaceholderShape::Cylinder),
				P(-1, -2, 0.3f, 0.9f, EPlaceholderShape::FlatCube),
			},
		},
		{
			TEXT("市场"),
			FLinearColor(0.85f, 0.47f, 0.02f),
			{
				P(-5, -4, PI, 1.0f),
				P(-2, -4, PI, 1.0f),
				P(1, -4, PI, 0.95f),
				P(4, -4, PI, 0.95f),
				P(-5, 4, 0.0f, 1.0f),
				P(-2, 4, 0.0f, 0.95f),
				P(1, 4, 0.0f, 0.95f),
				P(4, 4, 0.0f, 0.95f),
				P(-6, 0, PI / 2, 0.9f),
				P(6, -1, -PI / 2, 0.9f),
				P(0, 1, PI / 6, 1.1f, EPlaceholderShape::FlatCube),
				P(-3, 0, PI / 2, 1.0f, EPlaceholderShape::FlatCube),
				P(3, 0, -PI / 2, 1.0f, EPlaceholderShape::FlatCube),
				P(3, 2, 0.0f, 0.85f, EPlaceholderShape::Cylinder),
				P(-3, -2, 1.0f, 0.85f, EPlaceholderShape::Cylinder),
			},
		},
		{
			TEXT("餐厅"),
			FLinearColor(0.86f, 0.15f, 0.15f),
			{
				P(0, 2, -PI / 5, 1.15f),
				P(-4, -1, PI / 3, 1.05f),
				P(4, -1, -PI / 3, 1.0f),
				P(-4, 3, PI / 4, 0.95f),
				P(4, 3, -PI / 4, 0.95f),
				P(0, -4, PI, 0.9f),
				P(-5, -4, 3 * PI / 4, 0.88f),
				P(-2, 4, 0.5f, 0.8f, EPlaceholderShape::Cylinder),
				P(1, 4, 1.2f, 0.8f, EPlaceholderShape::Cylinder),
				P(3, 3, 2.0f, 0.8f, EPlaceholderShape::Cylinder),
				P(2, -3, PI, 0.85f, EPlaceholderShape::FlatCube),
			},
		},
		{
			TEXT("面包店"),
			FLinearColor(0.63f, 0.38f, 0.03f),
			{
				P(-4, 0, PI / 2, 1.1f),
				P(4, 0, -PI / 2, 1.1f),
				P(0, -4, PI, 1.05f),
				P(-2, 3, 0.0f, 0.95f),
				P(2, 3, -PI / 6, 0.9f),
				P(-5, -3, PI / 4, 0.9f),
				P(5, -3, -PI / 4, 0.9f),
				P(0, 4, 0.0f, 0.88f),
				P(3, 3, -PI / 6, 0.9f, EPlaceholderShape::FlatCube),
				P(-3, 3, PI / 3, 0.85f, EPlaceholderShape::FlatCube),
				P(1, -2, 0.0f, 0.8f, EPlaceholderShape::Cylinder),
			},
		},
		{
			TEXT("住宅区"),
			FLinearColor(0.23f, 0.51f, 0.96f),
			{
				P(-4, -5, PI, 0.95f),
				P(-1, -5, PI, 0.95f),
				P(2, -5, PI, 0.93f),
				P(5, -5, PI, 0.93f),
				P(-5, -2, PI / 2, 0.95f),
				P(-2, -2, PI / 4, 0.93f),
				P(1, -2, -PI / 4, 0.93f),
				P(4, -2, -PI / 2, 0.95f),
				P(-3, 1, PI / 2, 0.93f),
				P(0, 1, 0.0f, 0.95f),
				P(3, 1, -PI / 2, 0.93f),
				P(-4, 4, 3 * PI / 4, 0.93f),
				P(-1, 4, 0.0f, 0.95f),
				P(2, 4, 0.0f, 0.93f),
				P(5, 4, -3 * PI / 4, 0.93f),
			},
		},
		{
			TEXT("镇政厅"),
			FLinearColor(0.39f, 0.40f, 0.95f),
			{
				P(0, -2, 0.0f, 1.25f, EPlaceholderShape::TallCylinder),
				P(-5, 0, PI / 6, 1.05f, EPlaceholderShape::TallCylinder),
				P(5, 0, -PI / 6, 1.0f, EPlaceholderShape::TallCylinder),
				P(-4, 4, PI, 0.95f),
				P(4, 4, PI, 0.95f),
				P(-5, -4, PI / 3, 0.9f),
				P(5, -4, -PI / 3, 0.9f),
				P(0, 4, 0.0f, 0.85f, EPlaceholderShape::TallCylinder),
				P(-2, 3, 0.0f, 0.75f, EPlaceholderShape::Cylinder),
				P(2, 3, 1.2f, 0.75f, EPlaceholderShape::Cylinder),
			},
		},
		{
			TEXT("公园"),
			FLinearColor(0.13f, 0.77f, 0.37f),
			{
				P(-5, 2, 0.0f, 0.85f, EPlaceholderShape::Cylinder),
				P(2, 1, 1.2f, 0.85f, EPlaceholderShape::Cylinder),
				P(-1, -3, 0.4f, 0.85f, EPlaceholderShape::Cylinder),
				P(4, -1, 2.1f, 0.85f, EPlaceholderShape::Cylinder),
				P(-3, -1, 0.6f, 0.85f, EPlaceholderShape::Cylinder),
				P(1, 4, 1.8f, 0.85f, EPlaceholderShape::Cylinder),
				P(5, 3, 2.5f, 0.8f, EPlaceholderShape::Cylinder),
				P(0, 0, 0.9f, 0.8f, EPlaceholderShape::Cylinder),
				P(-4, -4, PI / 4, 0.9f, EPlaceholderShape::FlatCube),
				P(3, -3, -PI / 3, 0.9f, EPlaceholderShape::FlatCube),
				P(-2, 4, PI / 6, 0.85f, EPlaceholderShape::FlatCube),
				P(-6, -4, PI / 3, 0.8f),
				P(6, 4, -PI / 4, 0.75f),
			},
		},
	};
	return Regions;
}
