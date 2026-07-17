interface IEmpty {};

interface IBasic
{
    void DoSomething();
};

interface IMyInterface : IInterface
{
    UFUNCTION()
    void DoAction();

    UFUNCTION(BlueprintPure)
    float GetSpeed() const;
};

interface IFoo
{
    UFUNCTION()
    void FooMethod();
};

interface IBar
{
    UFUNCTION()
    void BarMethod();
};

class AMyActor : AActor, IFoo, IBar
{
    UFUNCTION(BlueprintOverride)
    void FooMethod() {}

    UFUNCTION(BlueprintOverride)
    void BarMethod() {}
};
