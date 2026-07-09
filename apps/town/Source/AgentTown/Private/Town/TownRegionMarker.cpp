#include "Town/TownRegionMarker.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/StaticMesh.h"
#include "UObject/ConstructorHelpers.h"

ATownRegionMarker::ATownRegionMarker()
{
	PrimaryActorTick.bCanEverTick = false;

	MeshComponent = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("RegionMesh"));
	SetRootComponent(MeshComponent);

	static ConstructorHelpers::FObjectFinder<UStaticMesh> SphereMesh(
		TEXT("/Engine/BasicShapes/Sphere.Sphere"));
	if (SphereMesh.Succeeded())
	{
		MeshComponent->SetStaticMesh(SphereMesh.Object);
		MeshComponent->SetRelativeScale3D(FVector(1.5f));
	}

	MeshComponent->SetCollisionEnabled(ECollisionEnabled::NoCollision);
}

void ATownRegionMarker::InitRegion(const FString& InRegionName, const FVector& WorldLocation)
{
	RegionName = InRegionName;
	SetActorLocation(WorldLocation);
	SetActorLabel(FString::Printf(TEXT("Region_%s"), *RegionName));
}
