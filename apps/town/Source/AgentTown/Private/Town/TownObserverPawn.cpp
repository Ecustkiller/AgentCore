#include "Town/TownObserverPawn.h"
#include "Camera/CameraComponent.h"
#include "GameFramework/SpringArmComponent.h"
#include "Simulation/WireCoordinateTransform.h"

namespace TownCamera
{
	/** Desktop TOWN_VIEW_CENTER — wire (9, 0, 5). */
	static const FVector ViewCenterWire(9.0, 0.0, 5.0);
	/** Desktop TOWN_CAMERA_POS — wire (48, 40, 44). */
	static const FVector CameraWire(48.0, 40.0, 44.0);
}

ATownObserverPawn::ATownObserverPawn()
{
	PrimaryActorTick.bCanEverTick = false;

	SpringArm = CreateDefaultSubobject<USpringArmComponent>(TEXT("SpringArm"));
	SpringArm->TargetArmLength = 2800.0f;
	SpringArm->SetRelativeRotation(FRotator(-50.0f, -45.0f, 0.0f));
	SpringArm->bDoCollisionTest = false;
	RootComponent = SpringArm;

	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(SpringArm);
}

void ATownObserverPawn::BeginPlay()
{
	Super::BeginPlay();

	const FVector ViewCenter = FWireCoordinateTransform::ToUnreal(
		TownCamera::ViewCenterWire.X,
		TownCamera::ViewCenterWire.Y,
		TownCamera::ViewCenterWire.Z);
	const FVector CameraPos = FWireCoordinateTransform::ToUnreal(
		TownCamera::CameraWire.X,
		TownCamera::CameraWire.Y,
		TownCamera::CameraWire.Z);

	SetActorLocation(ViewCenter);

	const FVector ToCamera = CameraPos - ViewCenter;
	const float YawDeg = FMath::RadiansToDegrees(FMath::Atan2(ToCamera.Y, ToCamera.X));
	const float HorizDist = FVector2D(ToCamera.X, ToCamera.Y).Size();
	const float PitchDeg = -FMath::RadiansToDegrees(FMath::Atan2(ToCamera.Z, HorizDist));

	SpringArm->SetRelativeRotation(FRotator(PitchDeg, YawDeg, 0.0f));
	SpringArm->TargetArmLength = ToCamera.Size();
}
