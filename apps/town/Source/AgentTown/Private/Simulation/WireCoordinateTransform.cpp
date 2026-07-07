#include "Simulation/WireCoordinateTransform.h"

bool FWireVec3::IsFinite() const
{
	return FMath::IsFinite(X) && FMath::IsFinite(Y) && FMath::IsFinite(Z);
}

FVector FWireCoordinateTransform::ToUnreal(const FWireVec3& Wire)
{
	return ToUnreal(Wire.X, Wire.Y, Wire.Z);
}

FVector FWireCoordinateTransform::ToUnreal(double WireX, double WireY, double WireZ)
{
	return FVector(
		static_cast<float>(WireX),
		static_cast<float>(-WireZ),
		static_cast<float>(WireY));
}
