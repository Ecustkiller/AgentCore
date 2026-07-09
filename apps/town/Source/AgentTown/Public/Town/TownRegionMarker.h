#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "TownRegionMarker.generated.h"

/** Visual anchor for a named simulation region (fixture-driven). */
UCLASS()
class AGENTTOWN_API ATownRegionMarker : public AActor
{
	GENERATED_BODY()

public:
	ATownRegionMarker();

	void InitRegion(const FString& InRegionName, const FVector& WorldLocation);

	const FString& GetRegionName() const { return RegionName; }

private:
	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UStaticMeshComponent> MeshComponent;

	FString RegionName;
};
