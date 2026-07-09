#include "Town/TownBootstrap.h"
#include "Town/TownBuildingSpawner.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/StaticMesh.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Materials/Material.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "NavigationSystem.h"
#include "NavMesh/NavMeshBoundsVolume.h"
#include "Components/BoxComponent.h"
#include "Simulation/WireCoordinateTransform.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

ATownBootstrap::ATownBootstrap()
{
	PrimaryActorTick.bCanEverTick = false;
}

void ATownBootstrap::BeginPlay()
{
	Super::BeginPlay();
	BuildTown();
}

void ATownBootstrap::BuildTown()
{
	if (bTownBuilt)
	{
		return;
	}
	bTownBuilt = true;

	SpawnGroundPlane();
	SpawnTownVisuals();
	SpawnRegionMarkers();
	BuildTownNavMesh();
}

void ATownBootstrap::BuildTownNavMesh()
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return;
	}

	UNavigationSystemV1* NavSys = FNavigationSystem::GetCurrent<UNavigationSystemV1>(World);
	if (!NavSys)
	{
		UE_LOG(LogTemp, Warning, TEXT("TownBootstrap: NavigationSystem unavailable — NPCs cannot pathfind"));
		return;
	}

	// The town is fully procedural (runtime C++, no baked .umap). A NavMeshBoundsVolume's
	// brush can only be built by editor-only BSP tools (UnrealEd), so it is empty in a
	// packaged build. Instead we give the volume a valid bound at runtime via a UBoxComponent:
	// the navigation system derives the nav bound from GetComponentsBoundingBox() (the union of
	// ALL components), not the brush specifically — see UNavigationSystemV1::OnNavigationBoundsUpdated.
	// Paired with RuntimeGeneration=Dynamic + bAutoCreateNavigationData=True (DefaultEngine.ini),
	// Recast auto-creates the RecastNavMesh and generates tiles around the runtime-spawned ground
	// in BOTH the editor and packaged (WITH_EDITOR=0) builds.
	//
	// Extent covers the 88×72 wire-meter footprint (±5500 / ±4500 cm) with margin; Z spans from
	// below the ground plane up through agent height.
	const FVector TownHalfExtent(5500.0f, 4500.0f, 1000.0f);

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	NavMeshBounds = World->SpawnActor<ANavMeshBoundsVolume>(
		ANavMeshBoundsVolume::StaticClass(),
		FVector::ZeroVector,
		FRotator::ZeroRotator,
		Params);
	if (!NavMeshBounds)
	{
		UE_LOG(LogTemp, Warning, TEXT("TownBootstrap: failed to spawn NavMeshBoundsVolume"));
		return;
	}

	UBoxComponent* BoundsBox = NewObject<UBoxComponent>(NavMeshBounds, TEXT("TownNavBoundsExtent"));
	BoundsBox->SetBoxExtent(TownHalfExtent, /*bUpdateOverlaps=*/ false);
	BoundsBox->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	BoundsBox->SetupAttachment(NavMeshBounds->GetRootComponent());
	BoundsBox->RegisterComponent();

	// Push the now-valid bounds to the navigation system, then kick a build so it creates the
	// RecastNavMesh instance (SpawnMissingNavigationData) and generates tiles around the
	// runtime-spawned ground immediately. Verified in a game world: this produces
	// "RebuildAll building NavData ... RecastNavMesh" + tile generation with RuntimeGeneration=Dynamic.
	NavSys->OnNavigationBoundsUpdated(NavMeshBounds);
	NavSys->Build();

	const FBox NavBox = NavMeshBounds->GetComponentsBoundingBox(true);
	UE_LOG(
		LogTemp,
		Log,
		TEXT("TownBootstrap: registered nav bounds min=(%.0f,%.0f,%.0f) max=(%.0f,%.0f,%.0f)"),
		NavBox.Min.X, NavBox.Min.Y, NavBox.Min.Z,
		NavBox.Max.X, NavBox.Max.Y, NavBox.Max.Z);
}

bool ATownBootstrap::SpawnGroundPlane()
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return false;
	}

	UStaticMesh* PlaneMesh = LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Plane.Plane"));
	if (!PlaneMesh)
	{
		return false;
	}

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	AStaticMeshActor* Ground = World->SpawnActor<AStaticMeshActor>(
		AStaticMeshActor::StaticClass(),
		FVector::ZeroVector,
		FRotator::ZeroRotator,
		Params);

	if (!Ground)
	{
		return false;
	}

	UStaticMeshComponent* GroundMesh = Ground->GetStaticMeshComponent();
	GroundMesh->SetStaticMesh(PlaneMesh);
	// 88×72 wire units (meters) — matches Desktop BASE_GRASS_SIZE (townGround.ts).
	GroundMesh->SetWorldScale3D(FVector(88.0f, 72.0f, 1.0f));
	GroundMesh->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
	GroundMesh->SetCollisionObjectType(ECollisionChannel::ECC_WorldStatic);

	UMaterialInterface* Parent = LoadObject<UMaterial>(
		nullptr,
		TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
	if (Parent)
	{
		UMaterialInstanceDynamic* GrassMat = UMaterialInstanceDynamic::Create(Parent, GroundMesh);
		GrassMat->SetVectorParameterValue(TEXT("Color"), FLinearColor(0.49f, 0.72f, 0.49f));
		GroundMesh->SetMaterial(0, GrassMat);
	}

	Ground->SetActorLabel(TEXT("TownGround"));
	return true;
}

bool ATownBootstrap::SpawnTownVisuals()
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return false;
	}

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

	BuildingSpawner = World->SpawnActor<ATownBuildingSpawner>(
		ATownBuildingSpawner::StaticClass(),
		FVector::ZeroVector,
		FRotator::ZeroRotator,
		Params);
	if (!BuildingSpawner)
	{
		return false;
	}

	BuildingSpawner->BuildTownVisuals();
	return true;
}

bool ATownBootstrap::SpawnRegionMarkers()
{
	UWorld* World = GetWorld();
	if (!World)
	{
		return false;
	}

	const FString FixturePath = FPaths::Combine(
		FPaths::ProjectContentDir(),
		TEXT("Fixtures/simulation-region-positions.json"));

	FString JsonText;
	if (!FFileHelper::LoadFileToString(JsonText, *FixturePath))
	{
		UE_LOG(LogTemp, Warning, TEXT("TownBootstrap: missing fixture %s"), *FixturePath);
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

	FActorSpawnParameters Params;
	Params.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;

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

		const FVector UePos = FWireCoordinateTransform::ToUnreal(X, Y, Z);
		ATownRegionMarker* Marker = World->SpawnActor<ATownRegionMarker>(
			ATownRegionMarker::StaticClass(),
			UePos + FVector(0.0f, 0.0f, 120.0f),
			FRotator::ZeroRotator,
			Params);

		if (Marker)
		{
			Marker->InitRegion(Entry.Key, Marker->GetActorLocation());
			RegionMarkers.Add(Marker);
		}
	}

	return RegionMarkers.Num() > 0;
}
